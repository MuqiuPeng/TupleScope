/**
 * The server as an agent meets it: spawned over stdio and called through the
 * SDK's own client.
 *
 * The workspace here points at a database on port 1, where nothing listens, on
 * purpose. Everything pinned below either must not need a database — naming a
 * misspelled scenario id, reading a stored run, finding the workspace file — or
 * is exactly what an unreachable one should produce. No suite's shared
 * database is touched, and no tool that writes is called.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RUN_REPORT_SCHEMA } from '@tuplescope/core';

const SERVER = fileURLToPath(new URL('./server.ts', import.meta.url));
/** Absolute: the server is started from directories tsx cannot be resolved from. */
const TSX = import.meta.resolve('tsx');

/** The parent's environment, minus the variable that would choose the workspace for the child. */
const BASE_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'TUPLESCOPE_CONFIG',
  ),
);

const WORKSPACE = `name: MCP Fixture
baseUrl: http://127.0.0.1:1
database:
  connectionString: postgresql://postgres:postgres@127.0.0.1:1/none
scenariosDir: scenarios
`;

const SCENARIO = `version: 1
id: alpha
title: Alpha
datasets:
  - id: one
    label: One
    steps:
      - id: ping
        name: Ping
        request: { method: GET, path: /health }
        assert:
          - response.status == 200
`;

/** Only what the prose reads, plus what the store needs to accept the file. */
const UNDECIDED_RUN = {
  schema: RUN_REPORT_SCHEMA,
  selector: 'alpha/one',
  scenario: { id: 'alpha', title: 'Alpha' },
  dataset: { id: 'one', label: 'One' },
  run: {
    id: 'run_000001',
    scenarioId: 'alpha',
    datasetId: 'one',
    coverage: 'full',
    engineStatus: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
  },
  verdict: {
    outcome: 'undecided',
    reason: '1 assertion could not be evaluated',
    assertions: { total: 1, passed: 0, failed: 0, unevaluable: 1, passedAsRefused: 0 },
    coverage: 'full',
    proves: 'full',
    boundedBy: [],
  },
  steps: [],
};

async function connect(options: {
  cwd: string;
  args?: ReadonlyArray<string>;
  env?: Record<string, string>;
}): Promise<Client> {
  const client = new Client({ name: 'tuplescope-mcp-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', TSX, SERVER, ...(options.args ?? [])],
      cwd: options.cwd,
      env: { ...BASE_ENV, ...options.env },
      stderr: 'ignore',
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return { isError: result.isError === true, text: content.map((c) => c.text ?? '').join('\n') };
}

/** A server that is not expected to serve: its exit code and what it said. */
function runToExit(args: ReadonlyArray<string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, SERVER, ...args], {
      cwd,
      env: BASE_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let root: string;
let ws: string;
let broken: string;
let client: Client;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuplescope-mcp-'));
  // Discovery stops at a repository root, so a walk from `root` finds nothing
  // above it however the machine running this is laid out.
  await mkdir(join(root, '.git'));

  ws = join(root, 'ws');
  await mkdir(join(ws, 'scenarios'), { recursive: true });
  await mkdir(join(ws, '.tuplescope', 'runs'), { recursive: true });
  await writeFile(join(ws, 'tuplescope.yaml'), WORKSPACE, 'utf8');
  await writeFile(join(ws, 'scenarios', 'alpha.yaml'), SCENARIO, 'utf8');
  await writeFile(join(ws, '.tuplescope', 'runs', 'run_000001.json'), JSON.stringify(UNDECIDED_RUN), 'utf8');

  broken = join(root, 'broken');
  await mkdir(join(broken, 'scenarios'), { recursive: true });
  await writeFile(join(broken, 'tuplescope.yaml'), WORKSPACE, 'utf8');
  await writeFile(join(broken, 'scenarios', 'bad.yaml'), 'version: 2\nid: bad\n', 'utf8');

  client = await connect({ cwd: ws });
});

after(async () => {
  await client?.close();
  await rm(root, { recursive: true, force: true });
});

describe('tuplescope-mcp', { timeout: 60_000 }, () => {
  it('names a scenario id that matches no file, and lists the ones that do', async () => {
    // It said "0 scenario(s) selected" — and only after asking the database,
    // which is unreachable here, so reaching this text at all proves the id
    // is checked first.
    const { isError, text } = await call(client, 'check_scenarios', { scenarioId: 'nosuch' });
    assert.equal(isError, true);
    assert.equal(text, 'No scenario `nosuch`. There is: alpha.');
  });

  it('leads a stored run with its verdict in prose, then the envelope', async () => {
    // get_run returned the envelope bare: `selector` first, and
    // `engineStatus: "passed"` before anything that said undecided in words.
    const { isError, text } = await call(client, 'get_run', { runId: 'last' });
    assert.equal(isError, false);
    assert.match(text.split('\n')[0] ?? '', /^UNDECIDED \(exit 3\) — this is NOT a pass and NOT a failure\./);
    const envelope = text.indexOf('{\n');
    assert.ok(envelope > 0, 'the envelope follows the prose');
    assert.equal((JSON.parse(text.slice(envelope)) as typeof UNDECIDED_RUN).verdict.outcome, 'undecided');
  });

  it('reports an unreachable database from describe_table in its siblings’ words', async () => {
    // It returned the driver's bare `connect ECONNREFUSED 127.0.0.1:1`.
    const table = await call(client, 'describe_table', { table: 'wallets' });
    const sibling = await call(client, 'list_tables');
    assert.equal(table.isError, true);
    assert.match(table.text, /^Could not reach the database for workspace `MCP Fixture`: /);
    assert.match(table.text, /Check `database\.connectionString` in .*tuplescope\.yaml, and that the database is running\./);
    assert.equal(table.text, sibling.text);
  });

  it('points at list_runs when a stored run is not there', async () => {
    const { isError, text } = await call(client, 'list_assertion_candidates', { runId: 'run_nope', stepId: 'ping' });
    assert.equal(isError, true);
    assert.equal(text, 'No stored run `run_nope`. list_runs shows what is there.');
  });

  it('says a scenario file that will not load blocks every tool, and how to get past it', async () => {
    const other = await connect({ cwd: broken });
    try {
      const { isError, text } = await call(other, 'list_scenarios');
      assert.equal(isError, true);
      assert.match(text, /bad\.yaml: unsupported `version: 2`/);
      assert.match(text, /Every tool that reads scenarios stops at this file until it loads\. Fix it/);
    } finally {
      await other.close();
    }
  });

  describe('finding the workspace', () => {
    it('serves the file --config names, from a directory with none of its own', async () => {
      // The flag was ignored: every tool answered "no tuplescope.yaml found",
      // whose remedy was to pass the flag.
      const other = await connect({ cwd: root, args: ['--config', join(ws, 'tuplescope.yaml')] });
      try {
        const { isError, text } = await call(other, 'list_scenarios');
        assert.equal(isError, false, text);
        assert.match(text, /^alpha {2}Alpha$/m);
      } finally {
        await other.close();
      }
    });

    it('lets --config outrank TUPLESCOPE_CONFIG, as the README orders them', async () => {
      const other = await connect({
        cwd: root,
        args: ['--config', join(ws, 'tuplescope.yaml')],
        env: { TUPLESCOPE_CONFIG: join(root, 'nope.yaml') },
      });
      try {
        const { isError, text } = await call(other, 'list_scenarios');
        assert.equal(isError, false, text);
      } finally {
        await other.close();
      }
    });

    it('says which knob named a missing file, and what to turn', async () => {
      const other = await connect({ cwd: root, env: { TUPLESCOPE_CONFIG: join(root, 'nope.yaml') } });
      try {
        const { isError, text } = await call(other, 'list_scenarios');
        assert.equal(isError, true);
        assert.match(text, /no such workspace file: .*nope\.yaml \(named by TUPLESCOPE_CONFIG\)/);
        assert.match(text, /pass --config <path>/);
      } finally {
        await other.close();
      }
    });

    it('with no workspace in reach, names both ways to point at one', async () => {
      const other = await connect({ cwd: root });
      try {
        const { isError, text } = await call(other, 'list_scenarios');
        assert.equal(isError, true);
        assert.match(text, /no tuplescope\.yaml found/);
        assert.match(text, /pass --config <path>, or set TUPLESCOPE_CONFIG=<path>\./);
      } finally {
        await other.close();
      }
    });

    it('refuses an option it does not understand, rather than ignoring it', async () => {
      const { code, stderr } = await runToExit(['--confg', join(ws, 'tuplescope.yaml')], root);
      assert.equal(code, 4);
      assert.match(stderr, /--confg/);
      assert.match(stderr, /Usage: tuplescope-mcp \[--config <path>\]/);
    });

    it('refuses an empty --config, which discovery would otherwise skip past', async () => {
      const { code, stderr } = await runToExit(['--config', ''], root);
      assert.equal(code, 4);
      assert.match(stderr, /--config needs a path/);
    });

    it('prints its usage for --help and exits cleanly', async () => {
      const { code, stdout } = await runToExit(['--help'], root);
      assert.equal(code, 0);
      assert.match(stdout, /^Usage: tuplescope-mcp \[--config <path>\]/);
    });
  });

  it('describes what its tools now return', async () => {
    // Each description is what an agent reads before choosing a call. They
    // said nothing of isError on a run, dropped types a build could not give,
    // and promised no gaps from describe_workspace.
    const { tools } = await client.listTools();
    const about = (name: string): string => tools.find((tool) => tool.name === name)?.description ?? '';
    assert.match(about('run_scenario'), /marked isError for every verdict but clean — failed, errored and undecided alike/);
    assert.match(about('describe_table'), /its columns and their declared types/);
    assert.match(about('describe_workspace'), /tables with no primary key or unique index, with what each costs/);
  });
});

// ─── with a database ──────────────────────────────────────────────────────────

const TEST_DATABASE =
  process.env['TUPLESCOPE_TEST_DATABASE_URL'] ?? 'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

/**
 * One step against a local API that answers 200 and stores nothing; only the
 * assertions differ, so only the verdict does. `atomic()` is undecided under
 * the default engine, whose fidelity is net.
 */
const VERDICTS = `version: 1
id: verdicts
title: Verdicts
datasets:
  - id: green
    label: Green
    steps:
      - id: ping
        name: Ping
        request: { method: GET, path: /health }
        assert:
          - response.status == 200
  - id: red
    label: Red
    steps:
      - id: ping
        name: Ping
        request: { method: GET, path: /health }
        assert:
          - response.status == 500
  - id: open
    label: Open
    steps:
      - id: ping
        name: Ping
        request: { method: GET, path: /health }
        assert:
          - response.status == 200
          - atomic(changes(*)) == true
`;

/**
 * run_scenario's isError, end to end. Needs TupleScope's own test database and
 * skips without it. The search path names a schema that does not exist, so the
 * scope holds no table at all: nothing another suite owns is watched, and
 * nothing is written anywhere.
 */
describe('run_scenario against a database', { timeout: 120_000 }, () => {
  let api: Server | undefined;
  let db: Client | undefined;
  let available = false;

  before(async () => {
    api = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((done) => api!.listen(0, '127.0.0.1', done));
    const port = (api.address() as AddressInfo).port;
    const options = encodeURIComponent('-c search_path=tuplescope_mcp_absent');
    const dir = join(root, 'db');
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await mkdir(join(dir, '.tuplescope', 'runs'), { recursive: true });
    await writeFile(
      join(dir, 'tuplescope.yaml'),
      `name: MCP Database Fixture
baseUrl: http://127.0.0.1:${port}
database:
  connectionString: "${TEST_DATABASE}${TEST_DATABASE.includes('?') ? '&' : '?'}options=${options}"
scenariosDir: scenarios
`,
      'utf8',
    );
    await writeFile(join(dir, 'scenarios', 'verdicts.yaml'), VERDICTS, 'utf8');
    db = await connect({ cwd: dir });
    available = !(await call(db, 'list_tables')).isError;
  });

  after(async () => {
    await db?.close();
    await new Promise((done) => (api ? api.close(done) : done(undefined)));
  });

  it('is not an error result for a clean run', async (t) => {
    if (!available) return t.skip('no database');
    const { isError, text } = await call(db!, 'run_scenario', { scenarioId: 'verdicts', datasetId: 'green' });
    assert.equal(isError, false, text);
    assert.match(text, /^CLEAN \(exit 0\) — 1 assertion evaluated and passed\./);
  });

  it('is an error result for a failed run, with the text unchanged', async (t) => {
    // Measured against the payment service: FAILED (exit 1), isError=false.
    if (!available) return t.skip('no database');
    const { isError, text } = await call(db!, 'run_scenario', { scenarioId: 'verdicts', datasetId: 'red' });
    assert.equal(isError, true, text);
    assert.match(text, /^FAILED \(exit 1\) — the system under test is wrong\./);
  });

  it('is an error result for an undecided run', async (t) => {
    // Measured: UNDECIDED (exit 3), isError=false.
    if (!available) return t.skip('no database');
    const { isError, text } = await call(db!, 'run_scenario', { scenarioId: 'verdicts', datasetId: 'open' });
    assert.equal(isError, true, text);
    assert.match(text, /^UNDECIDED \(exit 3\) — this is NOT a pass and NOT a failure\./);
  });

  it('is not an error result when policy lets the undecided one through, and says how many', async (t) => {
    if (!available) return t.skip('no database');
    const { isError, text } = await call(db!, 'run_scenario', {
      scenarioId: 'verdicts',
      datasetId: 'open',
      unevaluable: 'warn',
    });
    assert.equal(isError, false, text);
    assert.match(
      text,
      /^CLEAN \(exit 0\) — 1 of 2 assertions evaluated and passed; 1 could not be evaluated and was not counted against this run, by policy\./,
    );
  });
});

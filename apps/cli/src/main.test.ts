/**
 * The CLI as a person types it: a process, its arguments, its streams and its
 * exit code.
 *
 * Each case here was measured wrong from the outside before it was fixed, and
 * several were wrong only at the dispatch layer — `url --all` parsed into the
 * flags and was then looked for among the positionals — which no test of a
 * function could see. So these spawn `main.ts` and read what comes back.
 *
 * Nothing here needs a database. The macOS cases touch the login keychain
 * under a namespace nothing else uses and remove every item they create, as
 * `packages/secrets/src/macos.test.ts` does.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import type { AssertionResult, Run, StepResult } from '@tuplescope/core';
import { DEFAULT_POLICY, exitCodeOf, mergeVerdicts, verdictOf } from '@tuplescope/core';
import { buildEnvelope, RUN_REPORT_SCHEMA, type Envelope } from '@tuplescope/report';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
/** Absolute, so the CLI can be started from a directory that has no node_modules. */
const TSX = import.meta.resolve('tsx');
const onMac = process.platform === 'darwin';
/** A keychain slot nothing else uses. */
const NS = `tuplescope-cli-test-${process.pid}`;

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Asynchronous on purpose: a test's own HTTP server has to answer while it runs. */
function cli(args: string[], cwd: string, env: Record<string, string> = {}, input = ''): Promise<Result> {
  // FORCE_COLOR removed rather than emptied: set to anything, Node warns on
  // stderr that it overrides NO_COLOR, and the warning is two more lines of
  // stderr than the CLI wrote.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...env };
  delete childEnv['FORCE_COLOR'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, MAIN, ...args], { cwd, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const onlyAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text);
const noStack = (text: string): boolean => !/^\s+at /m.test(text);

let root: string;
let backend: Server;
let backendUrl: string;

async function workspace(name: string, yaml: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'tuplescope.yaml'), yaml);
  return dir;
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'tuplescope-cli-main-'));
  backend = createServer((_, response) => response.writeHead(200).end('ok'));
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('tuplescope url --all', () => {
  it('lists every live instance, as the hint promises', async () => {
    const home = join(root, 'url-home');
    await mkdir(join(home, '.tuplescope', 'sessions'), { recursive: true });
    // This test's own pid, so both read as live and neither is swept away.
    for (const [port, workspaceName, startedAt] of [
      [7001, 'One', '2026-09-01T00:00:00.000Z'],
      [7002, 'Two', '2026-09-02T00:00:00.000Z'],
    ] as const) {
      await writeFile(
        join(home, '.tuplescope', 'sessions', `${port}.json`),
        JSON.stringify({
          pid: process.pid,
          port,
          token: `t${port}`,
          url: `http://127.0.0.1:${port}/?token=t${port}`,
          workspace: workspaceName,
          startedAt,
        }),
      );
    }
    const env = { HOME: home, USERPROFILE: home };

    const all = await cli(['url', '--all'], root, env);
    assert.equal(all.code, 0, all.stderr);
    const lines = all.stdout.trim().split('\n');
    assert.equal(lines.length, 2, all.stdout);
    assert.match(lines[0]!, /7002\/\?token=t7002 {4}Two \(pid \d+, since 2026-09-02/);
    assert.match(lines[1]!, /7001\/\?token=t7001 {4}One \(pid \d+/);
    assert.equal(all.stderr, '');

    const newest = await cli(['url'], root, env);
    assert.equal(newest.stdout, 'http://127.0.0.1:7002/?token=t7002\n');
    assert.match(newest.stderr, /1 other instance\(s\) running — tuplescope url --all/);
  });
});

describe('tuplescope status', () => {
  it('asks the backend even when the database does not answer', async () => {
    const dir = await workspace(
      'status-nodb',
      `name: CLI status test\nbaseUrl: ${backendUrl}\nscenariosDir: scenarios\n` +
        'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n',
    );
    const result = await cli(['status'], dir);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /  database  Could not reach the database/);
    // Measured: the command returned at the database line, backend unmentioned.
    assert.match(result.stdout, /  backend   answering · HTTP 200/);

    const ascii = await cli(['status', '--ascii'], dir);
    assert.ok(onlyAscii(ascii.stdout + ascii.stderr), ascii.stdout + ascii.stderr);
    assert.match(ascii.stdout, /tuplescope - CLI status test -> /);
    assert.match(ascii.stdout, /backend   answering - HTTP 200/);
  });

  it('exits 4 for a secret that does not resolve, and still asks the backend', async () => {
    const dir = await workspace(
      'status-nosecret',
      `name: CLI status secret test\nbaseUrl: ${backendUrl}\nscenariosDir: scenarios\n` +
        `secrets: { namespace: ${NS} }\n` +
        'database:\n  connectionString: postgresql://postgres:${secret:not_here}@127.0.0.1:1/x\n',
    );
    const result = await cli(['status'], dir);
    // 4, as `ls` gives the same workspace: "a workspace that will not load".
    assert.equal(result.code, 4, result.stdout + result.stderr);
    assert.match(result.stdout, /database  not checked/);
    assert.match(result.stdout, /backend   answering · HTTP 200/);
    const ls = await cli(['ls'], dir);
    assert.equal(ls.code, 4);

    // The ✗ line and its dash are the command's own formatting, so --ascii
    // reaches them too.
    const ascii = await cli(['status', '--ascii'], dir);
    assert.ok(onlyAscii(ascii.stdout), ascii.stdout);
    assert.match(ascii.stdout, /not checked -- the workspace cannot open/);
  });

  it('names the dead backend and its remedy, and cannot exit 0 with one', async () => {
    const dir = await workspace(
      'status-nobackend',
      'name: CLI status backend test\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
        'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n',
    );
    const result = await cli(['status'], dir);
    // This fixture's database is down as well — nothing here starts one — so
    // what is pinned is that a backend which does not answer cannot come out
    // as 0, not that this 2 was the backend's alone.
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      // The suffix is the driver's own word for the failure, and a refused
      // connection to a literal address arrives without one, so it is optional
      // here and pinned exactly in the hung-server case below.
      /  backend   nothing is listening at http:\/\/127\.0\.0\.1:1(: [A-Z]+)?\n {12}Start it, then check again\.\n/,
    );

    const ascii = await cli(['status', '--ascii'], dir);
    assert.ok(onlyAscii(ascii.stdout + ascii.stderr), ascii.stdout + ascii.stderr);
    assert.match(ascii.stdout, /  backend   nothing is listening at http:\/\/127\.0\.0\.1:1/);
  });

  it('separates a server that never answered from a port with nothing on it', async () => {
    // Measured before the line carried the driver's word: a backend that
    // accepted the connection and then said nothing printed the identical
    // "nothing is listening at …" a closed port does, and its remedy sent the
    // reader to start a process that had been up the whole time.
    const hung = createServer(() => {});
    await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const port = (hung.address() as AddressInfo).port;
    try {
      const dir = await workspace(
        'status-hung',
        `name: CLI status hung test\nbaseUrl: http://127.0.0.1:${port}\nscenariosDir: scenarios\n` +
          'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n',
      );
      // Spends the probe's own deadline, three seconds, because that deadline
      // is the thing being reported on.
      const result = await cli(['status'], dir);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.match(
        result.stdout,
        new RegExp(`  backend   nothing is listening at http://127\\.0\\.0\\.1:${port}: it did not answer in time\n`),
      );
    } finally {
      // The aborted probe leaves a socket this server is still holding, and an
      // unclosed handle would keep the test runner alive past its last case.
      hung.closeAllConnections();
      await new Promise<void>((resolve) => hung.close(() => resolve()));
    }
  });

  it('says the backend was not checked, and never calls that unreachable', async () => {
    const dir = await workspace(
      'status-backend-secret',
      // The marker is in the path on purpose: in the host, `baseUrl` is not a
      // URL at all and the config is refused long before the probe.
      `name: CLI status backend secret test\nbaseUrl: http://127.0.0.1:3000/\${secret:tenant}\n` +
        `scenariosDir: scenarios\nsecrets: { namespace: ${NS} }\n` +
        'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n',
    );
    const result = await cli(['status'], dir);
    // 4, the same as every other command gives a workspace that will not load.
    assert.equal(result.code, 4, result.stdout + result.stderr);
    assert.match(
      result.stdout,
      /  backend   not checked — `baseUrl` refers to a secret that has not resolved\n {12}Resolve the secret, then check again\.\n/,
    );
    // The two states never merge: telling someone to start a server they
    // already started is how they learn to distrust the line.
    assert.doesNotMatch(result.stdout, /backend {3}nothing is listening/);

    const ascii = await cli(['status', '--ascii'], dir);
    assert.ok(onlyAscii(ascii.stdout + ascii.stderr), ascii.stdout + ascii.stderr);
    assert.match(
      ascii.stdout,
      /  backend   not checked -- `baseUrl` refers to a secret that has not resolved/,
    );
  });
});

describe('--help on a command with a surface of its own', () => {
  it('prints that surface and exits 0', async () => {
    for (const [args, head] of [
      [['handoff', '--help'], 'tuplescope handoff — '],
      [['handoff', '-h'], 'tuplescope handoff — '],
      [['handoff', 'help'], 'tuplescope handoff — '],
      [['secret', '--help'], 'tuplescope secret — '],
      [['secret', 'help'], 'tuplescope secret — '],
    ] as const) {
      const result = await cli([...args], root);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.ok(result.stdout.startsWith(head), `${args.join(' ')} printed:\n${result.stdout}`);
      assert.doesNotMatch(result.stdout, /run backend scenarios/);
    }
    const handoff = await cli(['handoff', '--help'], root);
    assert.match(handoff.stdout, /handoff enable <preset> --as <alias>/);
  });

  it('treats no subcommand as a bad invocation, for both', async () => {
    for (const command of ['handoff', 'secret']) {
      const result = await cli([command], root);
      assert.equal(result.code, 4, command);
      assert.match(result.stderr, new RegExp(`tuplescope ${command} — `));
      assert.equal(result.stdout, '');
    }
  });

  it('leaves the global help where it was', async () => {
    const result = await cli(['run', '--help'], root);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Run options/);
  });
});

describe('tuplescope handoff says only what is true', () => {
  it('does not promise a repository-named alias or a refusing scenario', async () => {
    const home = join(root, 'handoff-home');
    await mkdir(home, { recursive: true });
    const env = { HOME: home, USERPROFILE: home };
    const list = await cli(['handoff', 'list'], root, env);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /Nothing is bound on this machine/);
    // Nothing in the product reads an alias from a repository or refuses on one.
    assert.doesNotMatch(list.stdout, /scenario that names a handoff target/);
    assert.match(list.stdout, /tuplescope handoff enable <preset> --as <alias>/);

    const help = await cli(['handoff', '--help'], root, env);
    assert.doesNotMatch(help.stdout, /A repository can name an alias/);
    assert.match(help.stdout, /Nothing in a repository can create an alias/);
  });
});

describe('tuplescope ls --ascii', () => {
  it('prints no byte outside ASCII', async () => {
    const dir = await workspace(
      'ls-ascii',
      'name: CLI ls test\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
        'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n',
    );
    const result = await cli(['ls', '--ascii'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(onlyAscii(result.stdout), result.stdout);
    assert.match(result.stdout, /^tuplescope - CLI ls test -> http:\/\/127\.0\.0\.1:1$/m);
  });
});

// ─── report / run ─────────────────────────────────────────────────────────────

type Shape = 'clean' | 'failed' | 'undecided';

function envelopeFor(shape: Shape, selector: string): Envelope {
  const [scenarioId, datasetId] = selector.split('/') as [string, string];
  const assertions: AssertionResult[] = [
    { source: 'count(inserted(x)) == 1', status: 'passed' },
    shape === 'failed'
      ? { source: 'count(deleted(x)) == 0', status: 'failed', actual: '1', expected: '0' }
      : shape === 'undecided'
        ? { source: 'writeCount(changes(x)) == 1', status: 'unevaluable', reason: 'net view only' }
        : { source: 'count(deleted(x)) == 0', status: 'passed' },
  ];
  const step: StepResult = {
    stepId: 's',
    name: 's',
    status: shape === 'failed' ? 'failed' : 'passed',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:00.500Z',
    request: { method: 'POST', url: '/x', headers: {} },
    assertions,
  };
  const run = {
    id: `run_${datasetId}`,
    scenarioId,
    datasetId,
    coverage: 'full',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:01.000Z',
    status: shape === 'failed' ? 'failed' : 'passed',
    baseline: { probed: true, windowMs: 400 },
    steps: [step],
    variables: {},
  } as Run;
  const verdict = verdictOf(run, DEFAULT_POLICY);
  const suite = mergeVerdicts([verdict], DEFAULT_POLICY);
  return buildEnvelope(
    [
      {
        selector,
        scenario: { id: scenarioId, title: scenarioId, file: `/repo/${scenarioId}.yaml` },
        dataset: { id: datasetId, label: datasetId },
        run,
        verdict,
      },
    ],
    suite,
    {
      producer: { tool: 'tuplescope', version: '0.4.0', surface: 'cli' },
      workspace: {
        name: 'Demo Bank',
        configPath: '/repo/tuplescope.yaml',
        baseUrl: 'http://127.0.0.1:7421',
        scenariosDir: '/repo/scenarios',
        capture: { method: 'mvcc-xmin', detection: 'write', fidelity: 'net' },
        tableCount: 11,
      },
      invocation: {
        argv: ['run', selector],
        targets: [selector],
        startedAt: '2026-08-26T00:00:00.000Z',
        finishedAt: '2026-08-26T00:00:01.000Z',
        durationMs: 1000,
      },
      policy: { ...DEFAULT_POLICY, escalatedCodes: [], baselineWindowMs: 400, exitZero: false },
      exitCode: exitCodeOf(suite.outcome),
    },
  );
}

describe('tuplescope report', () => {
  let dir: string;
  before(async () => {
    dir = join(root, 'report');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'clean.json'), JSON.stringify(envelopeFor('clean', 'private/review')));
    await writeFile(join(dir, 'failed.json'), JSON.stringify(envelopeFor('failed', 'private/broke')));
    await writeFile(join(dir, 'undecided.json'), JSON.stringify(envelopeFor('undecided', 'private/maybe')));
  });

  it('merges totals and targets over every file', async () => {
    const result = await cli(['report', 'clean.json', 'failed.json', '--json'], dir);
    assert.equal(result.code, 1, result.stderr);
    const merged = JSON.parse(result.stdout) as Envelope;
    assert.equal(merged.runs.length, 2);
    assert.equal(merged.totals.runs, 2);
    assert.equal(merged.totals.datasets.failed, 1);
    assert.equal(merged.totals.assertions.total, 4);
    assert.equal(merged.totals.assertions.failed, 1);
    assert.deepEqual(merged.invocation.targets, ['private/review', 'private/broke']);
    assert.equal(merged.outcome, 'failed');
    assert.equal(merged.exitCode, 1);
  });

  it('exits by the merged outcome: failed + undecided is 1, not 3', async () => {
    const result = await cli(['report', 'failed.json', 'undecided.json'], dir);
    assert.match(result.stdout, /outcome {2}failed/);
    assert.match(result.stdout, /exit {5}1/);
    assert.equal(result.code, 1);
  });

  it('refuses --junit - with --json before reading anything', async () => {
    const result = await cli(['report', 'clean.json', '--junit', '-', '--json'], dir);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
    assert.match(result.stderr, /--json and --junit - both write to stdout/);
  });

  it('says in one line that a JUnit path cannot be written', async () => {
    const target = join(root, 'no-such-dir', 'out.xml');
    const result = await cli(['report', 'clean.json', '--junit', target], dir);
    assert.equal(result.code, 4, result.stderr);
    assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
    assert.ok(result.stderr.includes(target), result.stderr);
    assert.match(result.stderr, /does not exist/);
    assert.ok(noStack(result.stderr), result.stderr);
  });
});

describe('tuplescope run', () => {
  it('refuses --junit - with --json before looking for a workspace', async () => {
    const empty = join(root, 'no-workspace');
    await mkdir(empty, { recursive: true });
    const result = await cli(['run', '--junit', '-', '--json'], empty);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /--json and --junit - both write to stdout/);
    assert.doesNotMatch(result.stderr, /tuplescope\.yaml/);
  });

  it('checks the JUnit path before anything else happens', async () => {
    const dir = await workspace(
      'run-junit',
      'name: CLI run test\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
        'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n',
    );
    const target = join(root, 'no-such-dir', 'out.xml');
    const result = await cli(['run', '--junit', target], dir);
    // Without the check this workspace answers "no scenarios", exit 5 — the
    // run got as far as it could before the path was ever looked at.
    assert.equal(result.code, 4, result.stderr);
    assert.equal(result.stderr.trim(), `Cannot write the JUnit report to ${target}: the directory ${join(root, 'no-such-dir')} does not exist.`);
  });
});

// ─── output a reader stops reading, or needs in ASCII ──────────────────────────

/** The CLI with its stdout pipe closed before a byte is written, as `| true` leaves it. */
function cliUnread(args: string[], cwd: string): Promise<Result> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete childEnv['FORCE_COLOR'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, MAIN, ...args], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: '', stderr }));
  });
}

const NO_DB =
  'baseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
  'database:\n  connectionString: postgresql://postgres:x@127.0.0.1:1/x\n';

describe('a reader that stops reading', () => {
  it('ends the command quietly, with its own exit code', async () => {
    // Measured before: `status | true`, `ls | true`, `--help | true` each died
    // with an unhandled 'error' event, `write EPIPE` and a 25-line stack.
    const dir = await workspace('epipe', `name: CLI epipe test\n${NO_DB}`);
    for (const args of [['--help'], ['ls']]) {
      const result = await cliUnread(args, dir);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /EPIPE/, result.stderr);
      assert.ok(noStack(result.stderr), result.stderr);
    }
  });
});

describe('--ascii on text the packages wrote', () => {
  it('reaches a config error and the help', async () => {
    const dir = await workspace(
      'ascii-config',
      'name: CLI ascii config test\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
        'database:\n  connectionString: postgresql://postgres:${SECRET:db_password}@127.0.0.1:1/x\n',
    );
    const plain = await cli(['ls'], dir);
    assert.match(plain.stderr, /— lower-case `secret`/, 'the fixture must hold the glyph');
    const ascii = await cli(['ls', '--ascii'], dir);
    assert.equal(ascii.code, 4, ascii.stderr);
    assert.ok(onlyAscii(ascii.stderr), ascii.stderr);
    assert.match(ascii.stderr, /-- lower-case `secret`/);

    const help = await cli(['--help', '--ascii'], dir);
    assert.ok(onlyAscii(help.stdout), help.stdout);
    assert.match(help.stdout, /^tuplescope -- run backend scenarios/);
  });
});

describe('tuplescope runs', () => {
  it('says how many it left out, and how to see every one', async () => {
    // Measured before: 20 of 50 stored runs listed, and nothing said so.
    const dir = await workspace('runs-many', `name: CLI runs test\n${NO_DB}`);
    const runs = join(dir, '.tuplescope', 'runs');
    await mkdir(runs, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const id = `run_${String(i).padStart(4, '0')}`;
      const run = { id, scenarioId: 'topup', datasetId: 'happy', coverage: 'full', startedAt: '2026-09-01T00:00:00.000Z' };
      await writeFile(join(runs, `${id}.json`), JSON.stringify({ schema: RUN_REPORT_SCHEMA, run, verdict: { outcome: 'clean' } }));
    }
    await writeFile(join(runs, 'run_zzzz.json'), 'not json');

    const result = await cli(['runs'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.split('\n').filter((line) => /^  run_\d{4} /.test(line)).length, 20, result.stdout);
    assert.match(result.stdout, /the newest 20 of 25 stored runs; `tuplescope runs 25` lists every one/);
    assert.match(result.stdout, /1 more file\(s\) in .* could not be read by this build/);

    const every = await cli(['runs', '25'], dir);
    assert.equal(every.stdout.split('\n').filter((line) => /^  run_\d{4} /.test(line)).length, 25);
    assert.doesNotMatch(every.stdout, /the newest/);
  });
});

describe('the secret usage', () => {
  it('is what a refused flag on `secret` prints, not the whole help', async () => {
    const result = await cli(['secret', 'set', 'x', '--value', 'y'], root);
    assert.equal(result.code, 4);
    assert.match(result.stderr, /Unknown option '--value'/);
    assert.match(result.stderr, /tuplescope secret set <name> +store a value, read from the terminal or a pipe/);
    assert.doesNotMatch(result.stderr, /Run options/);
  });

  it('says `list` covers this workspace, not the machine', async () => {
    const result = await cli(['secret', '--help'], root);
    assert.match(result.stdout, /secret list +this workspace's secrets/);
    assert.doesNotMatch(result.stdout, /on this machine/);
  });
});

// ─── against the real keychain ────────────────────────────────────────────────

describe('secrets that reach the output', { skip: onMac ? false : 'not macOS' }, () => {
  const run = promisify(execFile);
  const service = (id: string) => `dev.tuplescope.secret.${NS}.${id}`;
  let dir: string;

  before(async () => {
    dir = await workspace(
      'keychain',
      `name: CLI keychain test\nbaseUrl: ${backendUrl}\nscenariosDir: scenarios\n` +
        `secrets: { namespace: ${NS} }\n` +
        // The secret as the host: the driver's own message then carries it.
        'database:\n  connectionString: postgresql://postgres:x@${secret:probe}:5432/postgres\n',
    );
    await writeFile(
      join(dir, 'foreign.yaml'),
      `name: CLI keychain test\nbaseUrl: ${backendUrl}\nscenariosDir: scenarios\n` +
        `secrets: { namespace: ${NS} }\n` +
        'database:\n  connectionString: postgresql://postgres:${secret:handmade}@127.0.0.1:1/x\n',
    );
    const set = await cli(['secret', 'set', 'probe'], dir, {}, 'scrubme-zz7q\n');
    assert.equal(set.code, 0, set.stderr);
    // Written the way a person would in Keychain Access: no TupleScope marker.
    await run('/usr/bin/security', [
      'add-generic-password', '-s', service('handmade'), '-a', 'tuplescope', '-w', 'Bearer cus_alice', '-U',
    ]);
  });

  after(async () => {
    for (const id of ['probe', 'handmade']) {
      await run('/usr/bin/security', ['delete-generic-password', '-s', service(id), '-a', 'tuplescope']).catch(
        () => undefined,
      );
    }
  });

  it('never prints a resolved value that a driver echoed back', async () => {
    for (const command of ['status', 'check']) {
      const result = await cli([command], dir);
      const all = result.stdout + result.stderr;
      assert.ok(!all.includes('scrubme-zz7q'), `${command} printed the secret:\n${all}`);
      assert.match(all, /\[secret probe\]/, `${command}:\n${all}`);
    }
    const ascii = await cli(['status', '--ascii'], dir);
    assert.ok(onlyAscii(ascii.stdout), ascii.stdout);
    assert.match(ascii.stdout, /secrets   \[ok\] probe/);
  });

  it('reports an item it did not write in one line, and in status as a ✗', async () => {
    const status = await cli(['status', '--config', 'foreign.yaml'], dir);
    assert.equal(status.code, 4, status.stdout + status.stderr);
    assert.match(status.stdout, /✗ handmade — The item stored for `handmade` in the macOS Keychain was not written by TupleScope/);
    assert.match(status.stdout, /backend   answering/);
    assert.ok(noStack(status.stderr), status.stderr);

    for (const args of [['ls', '--config', 'foreign.yaml'], ['secret', 'get', 'handmade']]) {
      const result = await cli(args, dir);
      assert.equal(result.code, 4, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(result.stderr.trim().split('\n').length, 1, result.stderr);
      assert.match(result.stderr, /was not written by TupleScope/);
    }
  });
});

/**
 * `--ascii` on the lines the info commands share.
 *
 * Measured: `status --ascii` and `ls --ascii` still printed `·`, `→` and `✓`
 * (under `cat -v`, `M-bM-^\M-^S db_password`), because the flag's table only
 * covered the run's diff glyphs. `check` prints the same header.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_POLICY, verdictOf, visible, type ChangeSet, type Run, type StepResult } from '@tuplescope/core';
import { auditScenarios, formatProblem } from '@tuplescope/scenario-engine';
import { redact, Secret } from '@tuplescope/secrets';
import { loadWorkspaceConfig, type ResolvedWorkspaceConfig } from '@tuplescope/workspace';
import { asciiGlyphs, escapeDocument } from './ascii.js';
import { renderRun, renderScope, renderWorkspaceLine } from './output.js';
import { renderSummary, renderWarning, type Style } from './render.js';
import { asciiDocument, installAsciiOutput, installScrubber, writeVerbatim } from './scrub.js';

const ascii: Style = { color: false, ascii: true, width: 100 };
const unicode: Style = { color: false, ascii: false, width: 100 };
const onlyAscii = (text: string): boolean => /^[\x00-\x7f]*$/.test(text);

const config = {
  name: 'Demo Bank',
  baseUrl: 'http://127.0.0.1:3000',
  configFile: '/repo/tuplescope.yaml',
} as ResolvedWorkspaceConfig;

const scope = {
  schema: 'public',
  watched: 3,
  otherSchemas: [{ schema: 'audit', tables: 2 }],
  nameFiltered: ['_migrations'],
  partitionedParents: ['events'],
  foreignTables: ['remote_rates'],
  keyless: ['audit_log', 'ts_probe'],
};

describe('--ascii on the info commands', () => {
  it('writes the workspace line in ASCII', () => {
    const line = renderWorkspaceLine(ascii, config);
    assert.ok(onlyAscii(line), line);
    assert.match(line, /tuplescope - Demo Bank -> http:\/\/127\.0\.0\.1:3000/);
  });

  it('writes the scope disclosure in ASCII', () => {
    const lines = renderScope(ascii, scope);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.ok(onlyAscii(line), line);
    assert.match(lines[0]!, /not watched - audit \(2 tables, another schema\) - _migrations/);
    assert.match(lines[1]!, /watched without a key - audit_log, ts_probe -- changes/);
  });

  it('keeps the unicode forms without the flag', () => {
    assert.match(renderWorkspaceLine(unicode, config), /tuplescope · Demo Bank → /);
    assert.match(renderScope(unicode, scope)[0]!, /not watched · audit/);
    assert.match(renderScope(unicode, scope)[1]!, /watched without a key · audit_log, ts_probe — changes/);
  });
});

/**
 * `status` and `check` name the schema and every gap in it, and a table with
 * no primary key and no unique index is a gap of its own. Measured with one
 * present: both described the schema exactly as without it, and the first a
 * reader heard of the table was an undecided run.
 */
describe('a keyless table in the scope', () => {
  const plain = { schema: 'public', watched: 3, otherSchemas: [], nameFiltered: [], partitionedParents: [], foreignTables: [] };

  it('is named, with what it costs', () => {
    const lines = renderScope(unicode, { ...plain, keyless: ['ts_probe'] });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /ts_probe/);
    assert.match(lines[0]!, /counted, not paired, and a deletion is invisible/);
  });

  it('says nothing when every watched table has a key', () => {
    assert.deepEqual(renderScope(unicode, { ...plain, keyless: [] }), []);
  });
});

// ─── everything the CLI writes ────────────────────────────────────────────────

/**
 * The flag as a transform on the streams, not a choice at each print site.
 *
 * Measured under `--ascii` before: `check` printed `excepts \`walletz\`, which
 * is not a table here — so it excludes nothing` and `checks nothing — it will
 * be observed…`; config errors kept `— lower-case \`secret\``; `run` printed
 * `topup · ghost`, `outcome  clean  · 3 assertions…`, the `proves` bullets and
 * every warning's `· step`. Most of those sentences are the packages', which
 * no style reaches.
 */

function fakeStream(): { write: (chunk: unknown) => boolean; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    write(chunk: unknown) {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    },
  };
}

const nonAscii = (text: string): string[] => [...text].filter((c) => c.codePointAt(0)! > 127);

/** A run whose diff holds a value with an accent: data, which must survive. */
function runWithData(): { run: Run; step: StepResult } {
  const changes = {
    captureMethod: 'mvcc-xmin',
    detection: 'write',
    fidelity: 'net',
    scope: { schema: 'public', database: 'test', allTables: true, tables: [] },
    changes: [
      {
        table: 'payments',
        kind: 'insert',
        key: { columns: [{ column: 'id', value: visible('text', 'pay_1') }], token: 'id=pay_1' },
        before: null,
        after: { id: visible('text', 'pay_1'), note: visible('text', 'café Zoë 東京') },
        changedColumns: ['id', 'note'],
        visibleColumns: ['id', 'note'],
        hasWrite: true,
      },
    ],
    rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
    warnings: [],
    durationMs: 1,
  } as unknown as ChangeSet;
  const step = {
    stepId: 'create',
    name: 'create',
    status: 'passed',
    startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T00:00:00.500Z',
    request: { method: 'POST', url: '/payments', headers: {} },
    assertions: [{ source: 'count(inserted(payments)) == 1', status: 'passed' }],
    changes,
  } as unknown as StepResult;
  const run = {
    id: 'run_ascii',
    scenarioId: 'topup',
    datasetId: 'ghost',
    coverage: 'full',
    startedAt: '2026-09-01T00:00:00.000Z',
    finishedAt: '2026-09-01T00:00:01.000Z',
    status: 'passed',
    baseline: { probed: false, windowMs: 0 },
    steps: [step],
    variables: {},
  } as unknown as Run;
  return { run, step };
}

async function configError(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tuplescope-ascii-'));
  try {
    const configPath = join(dir, 'tuplescope.yaml');
    await writeFile(
      configPath,
      'name: A\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
        'database:\n  connectionString: postgresql://postgres:${SECRET:db_password}@127.0.0.1:1/x\n',
    );
    await loadWorkspaceConfig({ configPath });
    throw new Error('the config loaded; the fixture needs one that does not');
  } catch (error) {
    return (error as Error).message;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('--ascii on everything the CLI writes', () => {
  it('leaves no glyph in run, check and config-error output, and every letter of the data', async () => {
    const { run } = runWithData();
    const verdict = verdictOf(run, DEFAULT_POLICY);
    const audit = auditScenarios(
      [
        {
          scenario: { id: 'probe', title: 'Probe', datasets: [] },
          dataset: {
            id: 'names',
            label: 'names',
            steps: [{ id: 's2', name: 's2', request: { method: 'GET', path: '/health' }, assert: [] }],
          },
        },
      ] as never,
      { tables: new Set(['payments']), columns: new Map() },
    );
    const lines = [
      ...renderRun(ascii, {}, config, run, verdict),
      ...renderWarning(
        ascii,
        { source: 'step', stepId: 'create', code: 'scope-truncated', severity: 'warning', message: 'a table was not read — see scope' } as never,
        '      ',
      ),
      ...renderSummary(ascii, verdict, 3),
      ...audit.problems.map((problem) => formatProblem(problem, '  ')),
      await configError(),
    ];
    const before = lines.join('\n');
    // The fixture has to hold the glyphs the transform is for, or this proves nothing.
    for (const glyph of ['·', '—']) assert.ok(before.includes(glyph), `fixture lost ${glyph}`);

    const out = fakeStream();
    installAsciiOutput([out]);
    out.write(`${before}\n`);
    const written = out.seen.join('');
    assert.match(written, /café Zoë 東京/, 'a value is data, not a glyph');
    assert.deepEqual(nonAscii(written.replaceAll('café Zoë 東京', '')), [], written);
    assert.match(written, /^topup - ghost$/m);
    assert.match(written, /checks nothing -- it will be observed/);
    assert.match(written, /-- lower-case `secret`/);
  });

  it('maps the tool\'s glyphs and no other character', () => {
    assert.equal(asciiGlyphs('a · b — c → d ✓ ✗ … • ⏎ ‹unknown› ⟨3B⟩'), 'a - b -- c -> d [ok] [FAIL] ... * \\n <unknown> (3B)');
    assert.equal(asciiGlyphs('café Zoë 東京 ñ'), 'café Zoë 東京 ñ');
  });

  it('scrubs before it spells, so a credential with a glyph in it is still found', () => {
    const out = fakeStream();
    installScrubber((line) => redact(line, [new Secret('pass·word-99', 'db_password')]), [out]);
    installAsciiOutput([out]);
    out.write('could not connect as pass·word-99');
    assert.equal(out.seen[0], 'could not connect as [secret db_password]');
  });

  it('prints a revealed value exactly, glyphs and all', () => {
    const out = fakeStream();
    installAsciiOutput([out]);
    writeVerbatim(out, 'Bearer a—b·c\n');
    assert.equal(out.seen[0], 'Bearer a—b·c\n');
    out.write('a—b');
    assert.equal(out.seen[1], 'a--b', 'only that one write is verbatim');
  });

  it('escapes a document instead of rewriting it, so a parser reads back the same values', () => {
    const envelope = { message: 'net view only — undecided', value: 'a—b·c', unknown: '‹unknown›', city: '東京 😀' };
    const json = escapeDocument(JSON.stringify(envelope, null, 2), 'json');
    assert.deepEqual(nonAscii(json), []);
    assert.deepEqual(JSON.parse(json), envelope);

    const xml = '<testcase name="topup · ghost"><failure message="expected ‹unknown› — café"/></testcase>';
    const escaped = escapeDocument(xml, 'xml');
    assert.deepEqual(nonAscii(escaped), []);
    assert.match(escaped, /name="topup &#xb7; ghost"/);
    assert.equal(escaped.split('<').length, xml.split('<').length, 'no markup added');
  });

  it('scrubs a document before escaping it, when the credential is not ASCII', () => {
    // Both calls take a fake stream, and the first one must. Without it
    // `installScrubber` defaults to `[process.stdout, process.stderr]` and wraps
    // this child's real stdout — which is the V8-serialised channel `node:test`
    // reports results to the parent over. The scrubber rewrote those bytes, the
    // parent could no longer parse them, and 60 lines of raw serialised summary
    // leaked into the suite output. It was never restored, so every later event
    // from this file went through it too: a corrupted `test:fail` is the case
    // where a real failure gets misreported as noise. Line 228 already did this
    // correctly, one test up.
    installScrubber((line) => redact(line, [new Secret('päss-word-1', 'db_password')]), [
      fakeStream(),
    ]);
    installAsciiOutput([fakeStream()]);
    const out = asciiDocument(JSON.stringify({ error: 'auth failed for päss-word-1' }), 'json');
    assert.equal(JSON.parse(out).error, 'auth failed for [secret db_password]');
  });
});

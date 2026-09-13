/**
 * That merging envelopes recomputes what it claims, and that its outcome and
 * exit code cannot disagree.
 *
 * Measured before this existed: `tuplescope report clean.json failed.json
 * --json` kept the first file's `totals` (1 run, 0 failed, 29 assertions)
 * beside a `runs` list of two with a failure; and `failed` merged with
 * `undecided` said `outcome failed` and exited 3, "nothing failed".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssertionResult, Run, StepResult, VerdictPolicy } from '@tuplescope/core';
import { DEFAULT_POLICY, exitCodeOf, mergeVerdicts, verdictOf } from '@tuplescope/core';
import { buildEnvelope, type Envelope } from './envelope.js';
import { mergeEnvelopes } from './merge.js';

const passed = (source = 'count(inserted(x)) == 1'): AssertionResult => ({ source, status: 'passed' });
const failed = (): AssertionResult => ({
  source: 'count(inserted(x)) == 1',
  status: 'failed',
  actual: '2',
  expected: '1',
});
const unevaluable = (): AssertionResult => ({
  source: 'writeCount(changes(x)) == 1',
  status: 'unevaluable',
  reason: 'this engine kept only the net view',
});

type Shape = 'clean' | 'failed' | 'undecided' | 'errored';

function stepFor(shape: Shape): StepResult {
  const base: StepResult = {
    stepId: 's',
    name: 's',
    status: 'passed',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:00.500Z',
    request: { method: 'POST', url: '/x', headers: {} },
    assertions: [passed(), passed('count(deleted(x)) == 0')],
  };
  if (shape === 'failed') return { ...base, status: 'failed', assertions: [passed(), failed()] };
  if (shape === 'undecided') return { ...base, assertions: [passed(), unevaluable()] };
  if (shape === 'errored') {
    return {
      ...base,
      status: 'errored',
      assertions: [],
      error: { kind: 'request', message: 'connect ECONNREFUSED' },
    };
  }
  return base;
}

function envelopeFor(
  shape: Shape,
  selector: string,
  options: { exitZero?: boolean; startedAt?: string; durationMs?: number; policy?: VerdictPolicy } = {},
): Envelope {
  const policy = options.policy ?? DEFAULT_POLICY;
  const [scenarioId, datasetId] = selector.split('/') as [string, string];
  const startedAt = options.startedAt ?? '2026-08-26T00:00:00.000Z';
  const run: Run = {
    id: `run_${datasetId}`,
    scenarioId,
    datasetId,
    coverage: 'full',
    startedAt,
    finishedAt: startedAt,
    status: shape === 'errored' ? 'errored' : shape === 'failed' ? 'failed' : 'passed',
    baseline: { probed: true, windowMs: 400 },
    steps: [stepFor(shape)],
    variables: {},
  } as Run;
  const verdict = verdictOf(run, policy);
  const suite = mergeVerdicts([verdict], policy);
  const natural = exitCodeOf(suite.outcome);
  const exitZero = options.exitZero ?? false;
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
        startedAt,
        finishedAt: startedAt,
        durationMs: options.durationMs ?? 1000,
      },
      policy: { ...policy, escalatedCodes: [], baselineWindowMs: 400, exitZero },
      exitCode: exitZero && (natural === 1 || natural === 3) ? 0 : natural,
      now: () => new Date('2026-08-26T00:00:03.000Z'),
    },
  );
}

describe('mergeEnvelopes', () => {
  it('says the merged count once, not each shard’s beside it', () => {
    // Each shard's own `boundedBy` was added back to the suite's, so two shards
    // with one undecided assertion each under --unevaluable warn read "1 …
    // was not counted" and "2 … were not counted" on adjacent lines.
    const warn: VerdictPolicy = { ...DEFAULT_POLICY, unevaluable: 'warn' };
    const merged = mergeEnvelopes([
      envelopeFor('undecided', 'probe/a', { policy: warn }),
      envelopeFor('undecided', 'probe/b', { policy: warn }),
    ]);
    assert.equal(merged.totals.assertions.unevaluable, 2);
    assert.deepEqual(merged.boundedBy, ['2 undecided assertions were not counted against this run, by policy']);
  });

  it('keeps a line a file says that its runs do not', () => {
    const edited = { ...envelopeFor('clean', 'refund/a'), boundedBy: ['added by hand'] };
    assert.ok(mergeEnvelopes([edited, envelopeFor('clean', 'refund/b')]).boundedBy.includes('added by hand'));
  });

  it('recomputes the totals over every run, not the first file', () => {
    const merged = mergeEnvelopes([
      envelopeFor('clean', 'private/review'),
      envelopeFor('failed', 'private/broke'),
    ]);
    assert.equal(merged.runs.length, 2);
    assert.equal(merged.totals.runs, 2);
    assert.deepEqual(merged.totals.datasets, {
      total: 2,
      clean: 1,
      failed: 1,
      undecided: 0,
      errored: 0,
    });
    assert.equal(merged.totals.assertions.total, 4);
    assert.equal(merged.totals.assertions.failed, 1);
    assert.equal(merged.totals.steps.total, 2);
  });

  it('names every file’s targets, and does not invent a command line', () => {
    const merged = mergeEnvelopes([
      envelopeFor('clean', 'private/review', { startedAt: '2026-08-26T00:00:00.000Z', durationMs: 400 }),
      envelopeFor('failed', 'private/broke', { startedAt: '2026-08-27T00:00:00.000Z', durationMs: 600 }),
    ]);
    assert.deepEqual(merged.invocation.targets, ['private/review', 'private/broke']);
    assert.deepEqual(merged.invocation.argv, []);
    assert.equal(merged.invocation.startedAt, '2026-08-26T00:00:00.000Z');
    assert.equal(merged.invocation.finishedAt, '2026-08-27T00:00:00.000Z');
    // The time spent in the runs, not the day between them.
    assert.equal(merged.invocation.durationMs, 1000);
  });

  it('keeps one file’s own invocation when there is only one', () => {
    const one = envelopeFor('failed', 'private/broke');
    const merged = mergeEnvelopes([one]);
    assert.deepEqual(merged.invocation, one.invocation);
    assert.deepEqual(merged.totals, one.totals);
    assert.equal(merged.outcome, one.outcome);
    assert.equal(merged.exitCode, one.exitCode);
  });

  // errored 2 > failed 1 > undecided 3 > clean 0 — the exit code follows the
  // outcome, never the larger number.
  const cases: Array<[Shape[], Shape, number]> = [
    [['failed', 'undecided'], 'failed', 1],
    [['undecided', 'failed'], 'failed', 1],
    [['clean', 'undecided'], 'undecided', 3],
    [['errored', 'undecided'], 'errored', 2],
    [['failed', 'errored'], 'errored', 2],
    [['clean', 'clean'], 'clean', 0],
  ];
  for (const [inputs, outcome, exitCode] of cases) {
    it(`${inputs.join(' + ')} is ${outcome} and exits ${exitCode}`, () => {
      const merged = mergeEnvelopes(inputs.map((shape, i) => envelopeFor(shape, `s/${shape}${i}`)));
      assert.equal(merged.outcome, outcome);
      assert.equal(merged.exitCode, exitCode);
      assert.equal(merged.exitCode, exitCodeOf(merged.outcome));
    });
  }

  it('keeps an --exit-zero cap only when every input was stored under it', () => {
    const capped = mergeEnvelopes([
      envelopeFor('failed', 'a/one', { exitZero: true }),
      envelopeFor('undecided', 'a/two', { exitZero: true }),
    ]);
    assert.equal(capped.outcome, 'failed');
    assert.equal(capped.exitCode, 0);
    assert.equal(capped.policy.exitZero, true);

    // One shard's cap is not a decision about the other's result.
    const mixed = mergeEnvelopes([
      envelopeFor('failed', 'a/one', { exitZero: true }),
      envelopeFor('undecided', 'a/two'),
    ]);
    assert.equal(mixed.outcome, 'failed');
    assert.equal(mixed.exitCode, 1);
    assert.equal(mixed.policy.exitZero, false);
  });

  it('never caps an errored merge, even when every input was capped', () => {
    const merged = mergeEnvelopes([
      envelopeFor('errored', 'a/one', { exitZero: true }),
      envelopeFor('failed', 'a/two', { exitZero: true }),
    ]);
    assert.equal(merged.exitCode, 2);
  });

  it('reads the worse of the runs and the file when a file disagrees with its runs', () => {
    // A hand-edited header cannot talk a failed run into a clean suite.
    const edited = { ...envelopeFor('failed', 'a/one'), outcome: 'clean' as const, exitCode: 0 };
    const merged = mergeEnvelopes([edited, envelopeFor('clean', 'a/two')]);
    assert.equal(merged.outcome, 'failed');
    assert.equal(merged.exitCode, 1);
  });

  it('refuses nothing to merge', () => {
    assert.throws(() => mergeEnvelopes([]), /at least one envelope/);
  });
});

/**
 * That a stored run reads back as the envelope it was saved from.
 *
 * `tuplescope report .tuplescope/runs/run_x.json` died with "Cannot read
 * properties of undefined (reading 'selector')": the file passed the schema
 * gate and was then merged as an envelope, which it is not. Found on the first
 * real install, by someone handing the tool the files it had just written.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssertionResult, Run, StepResult } from '@tuplescope/core';
import { DEFAULT_POLICY, exitCodeOf, mergeVerdicts, verdictOf } from '@tuplescope/core';
import { buildEnvelope, type Envelope } from './envelope.js';
import { envelopeOfStoredRun, isStoredRun, type StoredRunReport } from './stored.js';

const fail = (): AssertionResult => ({
  source: 'count(inserted(x)) == 1',
  status: 'failed',
  actual: '2',
  expected: '1',
});

function step(partial: Partial<StepResult> & Pick<StepResult, 'stepId'>): StepResult {
  return {
    name: partial.stepId,
    status: 'passed',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:00.500Z',
    request: { method: 'POST', url: '/x', headers: {} },
    assertions: [],
    ...partial,
  };
}

function envelopeFor(steps: StepResult[]): Envelope {
  const run: Run = {
    id: 'run_1',
    scenarioId: 'refund',
    datasetId: 'duplicate',
    coverage: 'full',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:02.000Z',
    status: 'passed',
    baseline: { probed: true, windowMs: 400 },
    steps,
    variables: {},
  };
  const verdict = verdictOf(run, DEFAULT_POLICY);
  const suite = mergeVerdicts([verdict], DEFAULT_POLICY);
  return buildEnvelope(
    [
      {
        selector: 'refund/duplicate',
        scenario: { id: 'refund', title: 'Refund lifecycle', file: '/repo/refund.yaml' },
        dataset: { id: 'duplicate', label: 'B. The same refund asked for twice' },
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
        argv: ['run', 'refund/duplicate'],
        targets: ['refund/duplicate'],
        startedAt: '2026-08-26T00:00:00.000Z',
        finishedAt: '2026-08-26T00:00:02.000Z',
        durationMs: 2000,
      },
      policy: { ...DEFAULT_POLICY, escalatedCodes: [], baselineWindowMs: 400, exitZero: false },
      exitCode: exitCodeOf(suite.outcome),
      now: () => new Date('2026-08-26T00:00:03.000Z'),
    },
  );
}

/**
 * Exactly what the CLI writes to `.tuplescope/runs`: the one run, with the
 * envelope's header spread over it — through JSON, as a file would be.
 */
function storedFrom(envelope: Envelope): StoredRunReport {
  const single = envelope.runs[0]!;
  return JSON.parse(
    JSON.stringify({
      ...single,
      run: { ...single.run, scenarioId: single.scenario.id, datasetId: single.dataset.id },
      schema: envelope.schema,
      producer: envelope.producer,
      workspace: envelope.workspace,
      policy: envelope.policy,
    }),
  ) as StoredRunReport;
}

describe('a stored run', () => {
  it('is told apart from an envelope, and from a bare header', () => {
    const envelope = envelopeFor([step({ stepId: 'refund', assertions: [fail()] })]);
    assert.equal(isStoredRun(envelope), false);
    assert.equal(isStoredRun(storedFrom(envelope)), true);
    // The schema alone is what the gate used to check, and it is not enough.
    assert.equal(isStoredRun({ schema: envelope.schema, producer: envelope.producer }), false);
  });

  it('reads back as the envelope it was saved from', () => {
    const envelope = envelopeFor([
      step({ stepId: 'create', assertions: [] }),
      step({ stepId: 'refund', status: 'failed', assertions: [fail()] }),
    ]);
    const back = envelopeOfStoredRun(storedFrom(envelope), () => new Date(envelope.generatedAt));
    assert.equal(back.runs.length, 1);
    assert.equal(back.runs[0]!.selector, 'refund/duplicate');
    assert.equal(back.outcome, envelope.outcome);
    assert.equal(back.exitCode, envelope.exitCode);
    assert.deepEqual(back.totals, envelope.totals);
    assert.equal(back.proves, envelope.proves);
    assert.deepEqual(back.boundedBy, envelope.boundedBy);
    assert.deepEqual(back.policy, envelope.policy);
    assert.deepEqual(back.workspace, envelope.workspace);
    assert.equal(back.schema, envelope.schema);
  });

  it('does not invent the command line it came from', () => {
    // A stored run never recorded its argv. Empty says so; a plausible one
    // would be a lie in a field CI systems display.
    const back = envelopeOfStoredRun(storedFrom(envelopeFor([step({ stepId: 'x' })])));
    assert.deepEqual(back.invocation.argv, []);
    assert.deepEqual(back.invocation.targets, ['refund/duplicate']);
    assert.equal(back.invocation.durationMs, 2000);
  });

  it('keeps the exit code a run under --exit-zero actually returned', () => {
    const envelope = envelopeFor([step({ stepId: 'refund', status: 'failed', assertions: [fail()] })]);
    assert.equal(envelope.outcome, 'failed');
    assert.equal(envelopeOfStoredRun(storedFrom(envelope)).exitCode, 1);
    const capped = storedFrom(envelope);
    capped.policy = { ...capped.policy, exitZero: true };
    assert.equal(envelopeOfStoredRun(capped).exitCode, 0);
  });
});

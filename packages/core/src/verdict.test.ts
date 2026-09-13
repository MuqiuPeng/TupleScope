/**
 * The forbidden green run has one gate, and this is it. Most of these cases
 * exist to make sure a particular combination cannot come out as `clean`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssertionResult, CaptureWarning, ChangeSet, Run, StepResult } from './index.js';
import {
  DEFAULT_POLICY,
  EXIT_CODE,
  exitCodeOf,
  mergeVerdicts,
  outcomeOfStep,
  resolveSeverity,
  severityOf,
  verdictOf,
  WARNING_SEVERITY,
  type VerdictPolicy,
} from './verdict.js';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const pass = (source = 'response.status == 200'): AssertionResult => ({ source, status: 'passed' });
const fail = (source = 'x == 1'): AssertionResult => ({
  source,
  status: 'failed',
  actual: '2',
  expected: '1',
});
const undecided = (source = 'hasWrite(changes(*)) == false'): AssertionResult => ({
  source,
  status: 'unevaluable',
  reason: 'needs write detection',
});

function changes(warnings: CaptureWarning[] = []): ChangeSet {
  return {
    captureMethod: 'mvcc-xmin',
    detection: 'write',
    fidelity: 'net',
    scope: { schema: 'public', database: 'test', allTables: true, tables: [] },
    changes: [],
    // Required, so a ChangeSet cannot exist without saying how its text was printed.
    rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
    warnings,
    durationMs: 1,
  };
}

function step(partial: Partial<StepResult> & Pick<StepResult, 'stepId'>): StepResult {
  return {
    name: partial.stepId,
    status: 'passed',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:01.000Z',
    request: { method: 'POST', url: '/x', headers: {} },
    assertions: [],
    ...partial,
  };
}

function run(partial: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    scenarioId: 'refund',
    datasetId: 'happy',
    coverage: 'full',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:05.000Z',
    status: 'passed',
    baseline: { probed: true, windowMs: 400 },
    steps: [],
    variables: {},
    ...partial,
  };
}

const lenient: VerdictPolicy = { ...DEFAULT_POLICY, unevaluable: 'warn' };

// ─── precedence ───────────────────────────────────────────────────────────────

describe('verdictOf precedence', () => {
  it('is clean when every assertion evaluated and passed', () => {
    const v = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass(), pass()] })] }));
    assert.equal(v.outcome, 'clean');
    assert.equal(v.proves, 'full');
    assert.deepEqual(v.boundedBy, []);
    assert.equal(v.assertions.passed, 2);
  });

  it('is undecided when an assertion could not be evaluated', () => {
    // The whole reason this module exists: the engine reports this run as
    // passed, because every step executed.
    const r = run({ status: 'passed', steps: [step({ stepId: 'a', assertions: [pass(), undecided()] })] });
    assert.equal(r.status, 'passed');
    const v = verdictOf(r);
    assert.equal(v.outcome, 'undecided');
    assert.match(v.reason, /did not establish what it claims/);
  });

  it('prefers failed over undecided', () => {
    const v = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [fail(), undecided()] })] }));
    assert.equal(v.outcome, 'failed');
    // ...and does not hide the undecided count while doing so.
    assert.equal(v.assertions.unevaluable, 1);
  });

  it('prefers errored over failed', () => {
    // An execution error means part of the suite never ran, so a failure
    // beneath it is a verdict over an incomplete suite.
    const v = verdictOf(
      run({
        steps: [
          step({ stepId: 'a', assertions: [fail()] }),
          step({ stepId: 'b', status: 'errored', error: { kind: 'request', message: 'ECONNREFUSED' } }),
        ],
      }),
    );
    assert.equal(v.outcome, 'errored');
    assert.match(v.reason, /ECONNREFUSED/);
    assert.equal(v.errors[0]?.stepId, 'b');
  });

  it('is failed when a step failed on status even with no failing assertion', () => {
    const v = verdictOf(run({ steps: [step({ stepId: 'a', status: 'failed', assertions: [pass()] })] }));
    assert.equal(v.outcome, 'failed');
  });
});

// ─── what the sentence names ──────────────────────────────────────────────────

const truncated = (table: string): CaptureWarning => ({
  code: 'scope-truncated',
  table,
  message: `\`${table}\` was rewritten during this step`,
});
const FIVE = ['accounts', 'addresses', 'blocks', 'customers', 'devices'];

describe('what the verdict sentence names', () => {
  it('names the warning and its tables when a capture warning decides the run', () => {
    // It used to read "the observation was incomplete: the observation was cut
    // short, …" — the same noun twice, and no table, over a step that
    // truncated thirty-five of them.
    const v = verdictOf(
      run({ steps: [step({ stepId: 'reset', assertions: [pass()], changes: changes(FIVE.map(truncated)) })] }),
    );
    assert.equal(v.outcome, 'undecided');
    assert.match(v.reason, /^scope-truncated on accounts, addresses, blocks and 2 more: the observation was cut short/);
    assert.doesNotMatch(v.reason, /observation was incomplete/);
  });

  it('says once per kind of warning what it bounds, and where', () => {
    const v = verdictOf(
      run({ steps: [step({ stepId: 'reset', assertions: [pass()], changes: changes(FIVE.map(truncated)) })] }),
    );
    const said = v.boundedBy.filter((b) => /cut short/.test(b));
    assert.equal(said.length, 1, v.boundedBy.join('\n'));
    assert.match(said[0]!, /\(accounts, addresses, blocks and 2 more\)$/);
    // Every warning is still there to be read one by one.
    assert.equal(v.warnings.length, 5);
  });

  it('does not say every assertion passed when some were let through undecided', () => {
    // Under --unevaluable warn, the headline said "4 assertions evaluated and
    // passed" directly above counts of 2 passed and 2 undecided.
    const v = verdictOf(
      run({ steps: [step({ stepId: 'a', assertions: [pass(), pass(), undecided(), undecided()] })] }),
      lenient,
    );
    assert.equal(v.outcome, 'clean');
    assert.equal(
      v.reason,
      '2 of 4 assertions evaluated and passed; 2 could not be evaluated and were not counted against this run, by policy',
    );
  });

  it('says the same of a suite whose undecided assertions are spread over datasets', () => {
    // Found through MCP run_scenario with no datasetId: each run's sentence was
    // right, and the suite's said "5 assertions evaluated and passed" over 2
    // undecided.
    const a = verdictOf(
      run({ steps: [step({ stepId: 'a', assertions: [pass(), pass(), undecided(), undecided()] })] }),
      lenient,
    );
    const b = verdictOf(run({ datasetId: 'other', steps: [step({ stepId: 'a', assertions: [pass()] })] }), lenient);
    const suite = mergeVerdicts([a, b], lenient);
    assert.equal(suite.outcome, 'clean');
    assert.match(
      suite.reason,
      /3 of 5 assertions evaluated and passed; 2 could not be evaluated and were not counted against this run, by policy$/,
    );
  });
});

// ─── policy ───────────────────────────────────────────────────────────────────

describe('policy', () => {
  it('lets --unevaluable=warn drop it out of the outcome, and says so', () => {
    const r = run({ steps: [step({ stepId: 'a', assertions: [pass(), undecided()] })] });
    const v = verdictOf(r, lenient);
    assert.equal(v.outcome, 'clean');
    // Demoted, never hidden: the run is still bounded and still says why.
    assert.equal(v.proves, 'bounded');
    assert.ok(v.boundedBy.some((b) => /not counted against this run, by policy/.test(b)));
    assert.equal(v.assertions.unevaluable, 1);
  });

  it('echoes the policy it judged under', () => {
    // A consumer must be able to see which judgement it is reading.
    assert.deepEqual(verdictOf(run(), lenient).policy, lenient);
  });

  it('treats zero assertions as clean by default and undecided on request', () => {
    const r = run({ steps: [step({ stepId: 'a' })] });
    assert.equal(verdictOf(r).outcome, 'clean');
    assert.equal(verdictOf(r, { ...DEFAULT_POLICY, requireAssertions: true }).outcome, 'undecided');
    // Either way it is visible as data.
    assert.equal(verdictOf(r).steps.unchecked, 1);
    assert.ok(verdictOf(r).boundedBy.some((b) => /checked none of them/.test(b)));
  });
});

// ─── capture warnings ─────────────────────────────────────────────────────────

describe('capture warnings', () => {
  const withWarning = (code: CaptureWarning['code']) =>
    run({
      steps: [
        step({
          stepId: 'a',
          assertions: [pass()],
          changes: changes([{ code, message: `${code} happened` }]),
        }),
      ],
    });

  it('escalates a warning that means the observation was incomplete', () => {
    for (const code of ['scope-truncated', 'reduced-fidelity'] as const) {
      const v = verdictOf(withWarning(code));
      assert.equal(v.outcome, 'undecided', `${code} should escalate`);
      assert.equal(v.warnings[0]?.severity, 'error');
    }
  });

  it('does not escalate a warning that only bounds attribution', () => {
    // Being lenient here is what makes strictness on unevaluable survivable: a
    // suite that is red every day for something nobody can fix gets ignored.
    for (const code of ['concurrent-writes-detected', 'degraded-row-identity'] as const) {
      const v = verdictOf(withWarning(code));
      assert.equal(v.outcome, 'clean', `${code} should not escalate`);
      // ...but the run is still qualified.
      assert.equal(v.proves, 'bounded');
      assert.equal(v.warnings[0]?.severity, 'warn');
    }
  });

  it('escalates a code it does not recognise', () => {
    // A warning from a newer producer is not one to guess about.
    assert.equal(severityOf('something-new-in-v0.4'), 'error');
    assert.equal(severityOf('scope-truncated'), 'error');
    assert.equal(severityOf('concurrent-writes-detected'), 'warn');
  });

  it('covers every declared warning code', () => {
    // If a code is added to CaptureWarning without a severity, this fails.
    const codes: Array<CaptureWarning['code']> = [
      'degraded-row-identity',
      'concurrent-writes-detected',
      'scope-truncated',
      'reduced-fidelity',
    ];
    for (const code of codes) assert.ok(WARNING_SEVERITY[code], `${code} has no severity`);
  });

  it('moves the whole table with --warnings strict / off', () => {
    const strict: VerdictPolicy = { ...DEFAULT_POLICY, warnings: 'strict' };
    const off: VerdictPolicy = { ...DEFAULT_POLICY, warnings: 'off' };
    assert.equal(resolveSeverity('concurrent-writes-detected', strict), 'error');
    assert.equal(resolveSeverity('scope-truncated', off), 'warn');

    const v = verdictOf(withWarning('concurrent-writes-detected'), strict);
    assert.equal(v.outcome, 'undecided');
    assert.equal(v.warnings[0]?.escalated, true);

    // Demoted is still reported.
    const w = verdictOf(withWarning('scope-truncated'), off);
    assert.equal(w.outcome, 'clean');
    assert.equal(w.warnings.length, 1);
    assert.equal(w.warnings[0]?.escalated, true);
    assert.equal(w.proves, 'bounded');
  });

  it('says where each warning came from', () => {
    const v = verdictOf(
      run({
        baselineNoise: changes([{ code: 'concurrent-writes-detected', message: 'sessions' }]),
        steps: [
          step({
            stepId: 'a',
            changes: changes([{ code: 'degraded-row-identity', table: 'audit', message: 'no key' }]),
          }),
        ],
      }),
    );
    assert.equal(v.warnings[0]?.source, 'baseline');
    assert.equal(v.warnings[1]?.source, 'step');
    assert.equal(v.warnings[1]?.stepId, 'a');
    for (const warning of v.warnings) assert.ok(warning.bounds.length > 0);
  });
});

// ─── what a run does not prove ────────────────────────────────────────────────

describe('proves / boundedBy', () => {
  it('says an unprobed baseline bounds the run, even when it is clean', () => {
    const v = verdictOf(run({ baseline: { probed: false, windowMs: 0 }, steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    assert.equal(v.outcome, 'clean');
    assert.equal(v.proves, 'bounded');
    assert.ok(v.boundedBy.some((b) => /concurrent writes would not have been detected/.test(b)));
    assert.equal(v.baseline.probed, false);
  });

  it('distinguishes a probe that found nothing from one that never ran', () => {
    const probed = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    assert.equal(probed.baseline.probed, true);
    assert.equal(probed.baseline.clean, true);
    assert.equal(probed.proves, 'full');
  });

  it('says a partial run proves less', () => {
    const v = verdictOf(run({ coverage: 'partial', steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    assert.equal(v.outcome, 'clean');
    assert.equal(v.proves, 'bounded');
    assert.ok(v.boundedBy.some((b) => /started mid-dataset/.test(b)));
  });
});

// ─── steps ────────────────────────────────────────────────────────────────────

describe('outcomeOfStep', () => {
  it('maps each engine status to an outcome', () => {
    assert.equal(outcomeOfStep(step({ stepId: 'a', assertions: [pass()] })), 'passed');
    assert.equal(outcomeOfStep(step({ stepId: 'a', assertions: [fail()] })), 'failed');
    assert.equal(outcomeOfStep(step({ stepId: 'a', assertions: [undecided()] })), 'undecided');
    assert.equal(outcomeOfStep(step({ stepId: 'a', status: 'errored' })), 'errored');
    assert.equal(outcomeOfStep(step({ stepId: 'a', status: 'skipped' })), 'not-run');
    assert.equal(outcomeOfStep(step({ stepId: 'a', assertions: [undecided()] }, ), lenient), 'passed');
  });

  it('is undecided for a step whose own capture the policy escalates, as the run is', () => {
    // It said `passed` for the one step whose observation was cut short, inside
    // a run verdictOf called undecided — and the web UI draws each step from
    // this, so that step got a green tick (ts-verify run_mtxeox8c).
    const cut = step({ stepId: 'reset', assertions: [pass()], changes: changes([truncated('customers')]) });
    assert.equal(outcomeOfStep(cut), 'undecided');
    const v = verdictOf(run({ steps: [cut] }));
    assert.equal(v.outcome, 'undecided');
    assert.equal(v.steps.undecided, 1);
    assert.equal(v.steps.passed, 0);
    // Policy-aware in both directions, exactly as verdictOf is.
    assert.equal(outcomeOfStep(cut, { ...DEFAULT_POLICY, warnings: 'off' }), 'passed');
    const noisy = step({
      stepId: 'a',
      assertions: [pass()],
      changes: changes([{ code: 'concurrent-writes-detected', message: 'sessions' }]),
    });
    assert.equal(outcomeOfStep(noisy), 'passed');
    assert.equal(outcomeOfStep(noisy, { ...DEFAULT_POLICY, warnings: 'strict' }), 'undecided');
    // A failure still outranks it, as it does for the run.
    assert.equal(outcomeOfStep({ ...cut, assertions: [fail()] }), 'failed');
  });

  it('does not count a step refused before it observed anything as unchecked', () => {
    // `unchecked` is "observed, but checked by no one". The stored refused runs
    // (ts-verify re-cli-run-flags, topup/ghost) said errored 1 and unchecked 1.
    const v = verdictOf(
      run({ steps: [step({ stepId: 'send', status: 'errored', error: { kind: 'configuration', message: 'refused' } })] }),
    );
    assert.equal(v.steps.errored, 1);
    assert.equal(v.steps.unchecked, 0);
    // A step that ran and asserted nothing still is.
    assert.equal(verdictOf(run({ steps: [step({ stepId: 'a', changes: changes() })] })).steps.unchecked, 1);
  });

  it('does not count a not-run step as unchecked', () => {
    const v = verdictOf(run({ steps: [step({ stepId: 'a', status: 'skipped' })] }));
    assert.equal(v.steps.notRun, 1);
    assert.equal(v.steps.unchecked, 0);
  });
});

// ─── suites ───────────────────────────────────────────────────────────────────

describe('steps that never ran', () => {
  /**
   * `steps.total` was `run.steps.length` — the number *attempted* — so a
   * dataset that halted on step 2 of 5 reported `total: 2, notRun: 0`,
   * `coverage: "full"`, `proves: "full"`. A step that was never reached could
   * not be counted as missing, because the denominator moved with the
   * numerator. A tool built to stop overclaiming, overclaiming in its own
   * machine-readable output.
   */
  const halted = run({
    declaredSteps: ['one', 'two', 'three', 'four', 'five'],
    steps: [
      step({ stepId: 'one', assertions: [pass()] }),
      step({ stepId: 'two', assertions: [fail()] }),
    ],
  });

  it('counts what was declared, not what was reached', () => {
    const v = verdictOf(halted);
    assert.equal(v.steps.total, 5);
    assert.equal(v.steps.passed, 1);
    assert.equal(v.steps.failed, 1);
    assert.equal(v.steps.notRun, 3);
  });

  it('says so in `proves`, and names them', () => {
    const v = verdictOf(halted);
    assert.equal(v.proves, 'bounded');
    const said = v.boundedBy.find((b) => /never ran/.test(b));
    assert.ok(said, 'a run that stopped early must say what it did not reach');
    assert.match(said, /three, four, five/);
  });

  it('leaves a complete run alone', () => {
    const whole = run({
      declaredSteps: ['one', 'two'],
      steps: [step({ stepId: 'one', assertions: [pass()] }), step({ stepId: 'two', assertions: [pass()] })],
    });
    const v = verdictOf(whole);
    assert.equal(v.steps.total, 2);
    assert.equal(v.steps.notRun, 0);
    assert.equal(v.proves, 'full');
  });

  it('falls back to what ran when nothing declared it', () => {
    // Runs stored before this field existed still have to render.
    const legacy = run({ steps: [step({ stepId: 'one', assertions: [pass()] })] });
    assert.equal(verdictOf(legacy).steps.total, 1);
    assert.equal(verdictOf(legacy).steps.notRun, 0);
  });
});

describe('mergeVerdicts', () => {
  const clean = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass()] })] }));
  const failed = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [fail()] })] }));
  const undecidedRun = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [undecided()] })] }));
  const errored = verdictOf(
    run({ steps: [step({ stepId: 'a', status: 'errored', error: { kind: 'database', message: 'down' } })] }),
  );

  it('is only as good as its worst member', () => {
    assert.equal(mergeVerdicts([clean, clean]).outcome, 'clean');
    assert.equal(mergeVerdicts([clean, undecidedRun]).outcome, 'undecided');
    assert.equal(mergeVerdicts([clean, undecidedRun, failed]).outcome, 'failed');
    assert.equal(mergeVerdicts([clean, undecidedRun, failed, errored]).outcome, 'errored');
  });

  it('sums the counts rather than losing them', () => {
    const suite = mergeVerdicts([clean, failed, undecidedRun]);
    assert.equal(suite.assertions.total, 3);
    assert.equal(suite.assertions.passed, 1);
    assert.equal(suite.assertions.failed, 1);
    assert.equal(suite.assertions.unevaluable, 1);
    assert.deepEqual(suite.datasets, { total: 3, clean: 1, failed: 1, undecided: 1, errored: 0 });
  });

  it('reports mixed coverage as mixed', () => {
    const partial = verdictOf(run({ coverage: 'partial', steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    assert.equal(mergeVerdicts([clean, partial]).coverage, 'mixed');
    assert.equal(mergeVerdicts([clean, clean]).coverage, 'full');
  });

  it('handles an empty suite without inventing a result', () => {
    const empty = mergeVerdicts([]);
    assert.equal(empty.outcome, 'clean');
    assert.equal(empty.reason, 'nothing ran');
    assert.equal(empty.datasets.total, 0);
  });

  it('counts the reason across every dataset, not just the deciding one', () => {
    // The line under it says `checks 23/23`. This one used to say 15 — the
    // first clean dataset's own total, pasted after a run-wide count. Two
    // numbers about different things, on adjacent lines, in the output of the
    // first command the README asks anyone to type.
    const three = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass(), pass(), pass()] })] }));
    const two = verdictOf(run({ steps: [step({ stepId: 'b', assertions: [pass(), pass()] })] }));
    const suite = mergeVerdicts([three, two]);
    assert.equal(suite.assertions.total, 5);
    assert.equal(suite.reason, '2 of 2 datasets passed cleanly: 5 assertions evaluated and passed');
  });

  it('counts the failures across every dataset too', () => {
    const oneFail = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [fail()] })] }));
    const twoFail = verdictOf(run({ steps: [step({ stepId: 'b', assertions: [fail(), fail()] })] }));
    const suite = mergeVerdicts([oneFail, twoFail, clean]);
    assert.equal(suite.assertions.failed, 3);
    assert.equal(suite.reason, '2 of 3 datasets failed: 3 assertions failed');
  });

  it('counts the undecided across every dataset', () => {
    const a = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [undecided()] })] }));
    const b = verdictOf(run({ steps: [step({ stepId: 'b', assertions: [undecided(), undecided()] })] }));
    assert.equal(mergeVerdicts([a, b, clean]).reason, '2 of 3 datasets undecided: 3 assertions could not be evaluated');
  });

  it('says nothing was asserted rather than reporting zero of them', () => {
    const bare = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [] })] }));
    // Two clean datasets that asserted nothing is not "0 assertions evaluated
    // and passed" — a count of nothing reads as a result.
    assert.match(mergeVerdicts([bare, bare]).reason, /nothing was asserted$/);
  });

  it('deduplicates the bounds so one cause is stated once', () => {
    const a = verdictOf(run({ baseline: { probed: false, windowMs: 0 }, steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    const b = verdictOf(run({ baseline: { probed: false, windowMs: 0 }, steps: [step({ stepId: 'b', assertions: [pass()] })] }));
    const suite = mergeVerdicts([a, b]);
    const unprobed = suite.boundedBy.filter((x) => /not probed/.test(x));
    assert.equal(unprobed.length, 1);
  });
});

// ─── what bounds a suite ──────────────────────────────────────────────────────

describe('what a suite is bounded by', () => {
  // A step refused before it sent: a `${…}` in its request. It never observed.
  const refused = () =>
    verdictOf(
      run({
        steps: [
          step({
            stepId: 'send',
            status: 'errored',
            error: { kind: 'configuration', message: '`request.body.token` refers to `${secret:foo}`' },
          }),
        ],
      }),
    );

  it('counts undecided-by-policy across datasets instead of collapsing identical sentences', () => {
    // Measured through MCP run_scenario {unevaluable: "warn"} and the CLI
    // envelope: "1 undecided assertion was not counted against this run, by
    // policy" beside counts of 2 undecided.
    const one = () =>
      verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass(), pass(), undecided()] })] }), lenient);
    const suite = mergeVerdicts([one(), one()], lenient);
    assert.equal(suite.assertions.unevaluable, 2);
    assert.deepEqual(suite.boundedBy, ['2 undecided assertions were not counted against this run, by policy']);
  });

  it('does not tell a suite that checked something that nothing was checked', () => {
    // Measured: two datasets refused before sending and one that passed its
    // only assertion; the suite said "no assertions were evaluated; the run
    // observed changes but checked none of them" over a checks line of 1/1.
    const ran = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass()], changes: changes() })] }));
    const suite = mergeVerdicts([refused(), refused(), ran]);
    assert.equal(suite.assertions.passed, 1);
    assert.ok(!suite.boundedBy.some((b) => /^no assertions were evaluated/.test(b)), suite.boundedBy.join('\n'));
    assert.ok(
      suite.boundedBy.includes('2 of 3 datasets evaluated no assertions, so nothing in them was checked'),
      suite.boundedBy.join('\n'),
    );
  });

  it('does not say a step refused before sending observed changes', () => {
    const v = refused();
    assert.deepEqual(v.boundedBy, [
      'no assertions were evaluated, and no step got as far as observing the database, so nothing was observed either',
    ]);
    // ...and a suite of nothing but those says it once, of the suite.
    assert.deepEqual(mergeVerdicts([refused(), refused()]).boundedBy, v.boundedBy);
  });

  it('says how many datasets a per-run sentence came from', () => {
    // "1 step never ran … : two" from each of two datasets is two steps, and
    // said once as if of the suite it was one.
    const halted = () =>
      verdictOf(run({ declaredSteps: ['one', 'two'], steps: [step({ stepId: 'one', assertions: [pass()] })] }));
    const clean = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    assert.ok(
      mergeVerdicts([halted(), halted(), clean]).boundedBy.includes(
        '1 step never ran, so nothing here establishes anything about it: two (in 2 of 3 datasets)',
      ),
    );
  });

  it('says a mid-dataset start and an unprobed baseline of the datasets they are true of', () => {
    const partial = verdictOf(
      run({ coverage: 'partial', baseline: { probed: false, windowMs: 0 }, steps: [step({ stepId: 'a', assertions: [pass()] })] }),
    );
    const clean = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass()] })] }));
    assert.deepEqual(mergeVerdicts([partial, clean]).boundedBy, [
      '1 of 2 datasets started mid-dataset, so earlier steps there left the database in whatever state the previous run did',
      'the baseline was not probed in 1 of 2 datasets, so concurrent writes there would not have been detected',
    ]);
  });

  it('keeps one line per kind of warning, naming every dataset’s tables', () => {
    const on = (table: string) =>
      verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass()], changes: changes([truncated(table)]) })] }));
    const cut = mergeVerdicts([on('accounts'), on('blocks')]).boundedBy.filter((b) => /cut short/.test(b));
    assert.deepEqual(cut, [
      'the observation was cut short, so an assertion that found nothing may only have been looking at less (accounts, blocks)',
    ]);
  });

  it('leaves a single dataset’s sentences exactly as the run said them', () => {
    const v = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass(), undecided()] })] }), lenient);
    assert.deepEqual(mergeVerdicts([v], lenient).boundedBy, v.boundedBy);
  });
});

// ─── exit codes ───────────────────────────────────────────────────────────────

describe('exit codes', () => {
  it('maps each outcome to its documented code', () => {
    assert.deepEqual(EXIT_CODE, { clean: 0, failed: 1, errored: 2, undecided: 3 });
  });

  it('keeps 1 meaning "the system under test is wrong"', () => {
    // A regression and a narrowed watch scope have opposite owners; merging
    // them into one code is what several other runners regret.
    assert.notEqual(exitCodeOf('undecided'), exitCodeOf('failed'));
    assert.notEqual(exitCodeOf('undecided'), exitCodeOf('errored'));
    assert.notEqual(exitCodeOf('undecided'), exitCodeOf('clean'));
  });

  it('never lets an undecided run exit zero under the default policy', () => {
    const v = verdictOf(run({ steps: [step({ stepId: 'a', assertions: [pass(), undecided()] })] }));
    assert.notEqual(exitCodeOf(v.outcome), 0);
  });
});

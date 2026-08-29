import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssertionResult, ChangeSet, Run, StepResult, VerdictPolicy } from '@tuplescope/core';
import { DEFAULT_POLICY, exitCodeOf, mergeVerdicts, verdictOf, visible } from '@tuplescope/core';
import { buildEnvelope, readAssertionOutcome, readStepOutcome, summariseChanges } from './envelope.js';
import { mapAssertion, outcomeFromCases, toJUnit } from './junit.js';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const pass = (source = 'response.status == 200'): AssertionResult => ({ source, status: 'passed' });
const fail = (source = 'count(inserted(x)) == 1'): AssertionResult => ({
  source,
  status: 'failed',
  actual: '2',
  expected: '1',
});
const undecided = (source = 'single(updated(wallets)).after.balance == "1000.00"'): AssertionResult => ({
  source,
  status: 'unevaluable',
  reason: 'single() expected exactly one row, found 2',
});

function changes(warnings: ChangeSet['warnings'] = []): ChangeSet {
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
    finishedAt: '2026-08-26T00:00:00.500Z',
    request: { method: 'POST', url: '/x', headers: {} },
    assertions: [],
    ...partial,
  };
}

function run(steps: StepResult[], partial: Partial<Run> = {}): Run {
  return {
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
    ...partial,
  };
}

function envelopeFor(steps: StepResult[], policy: VerdictPolicy = DEFAULT_POLICY, extra: Partial<Run> = {}) {
  const r = run(steps, extra);
  const verdict = verdictOf(r, policy);
  const suite = mergeVerdicts([verdict], policy);
  return buildEnvelope(
    [
      {
        selector: 'refund/duplicate',
        scenario: { id: 'refund', title: 'Refund lifecycle', file: '/repo/refund.yaml' },
        dataset: { id: 'duplicate', label: 'B. The same refund asked for twice' },
        run: r,
        verdict,
      },
    ],
    suite,
    {
      producer: { tool: 'tuplescope', version: '0.2.0', surface: 'cli' },
      workspace: {
        name: 'Demo Bank',
        configPath: '/repo/tuplescope.yaml',
        baseUrl: 'http://127.0.0.1:7421',
        scenariosDir: '/repo/scenarios',
        capture: { method: 'mvcc-xmin', detection: 'write', fidelity: 'net' },
        tableCount: 11,
      },
      invocation: {
        argv: ['run', 'refund/duplicate', '--junit', '-'],
        targets: ['refund/duplicate'],
        startedAt: '2026-08-26T00:00:00.000Z',
        finishedAt: '2026-08-26T00:00:02.000Z',
        durationMs: 2000,
      },
      policy: { ...policy, escalatedCodes: [], baselineWindowMs: 400, exitZero: false },
      exitCode: exitCodeOf(suite.outcome),
      now: () => new Date('2026-08-26T00:00:03.000Z'),
    },
  );
}

const attr = (xml: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1];

// ─── the invariant ────────────────────────────────────────────────────────────

describe('the XML and the exit code cannot disagree', () => {
  const combinations: Array<[string, StepResult[], VerdictPolicy]> = [
    ['all passing', [step({ stepId: 'a', assertions: [pass(), pass()] })], DEFAULT_POLICY],
    ['one failure', [step({ stepId: 'a', assertions: [pass(), fail()] })], DEFAULT_POLICY],
    ['one undecided', [step({ stepId: 'a', assertions: [pass(), undecided()] })], DEFAULT_POLICY],
    [
      'undecided, tolerated',
      [step({ stepId: 'a', assertions: [pass(), undecided()] })],
      { ...DEFAULT_POLICY, unevaluable: 'warn' },
    ],
    [
      'an execution error',
      [step({ stepId: 'a', status: 'errored', error: { kind: 'request', message: 'ECONNREFUSED' } })],
      DEFAULT_POLICY,
    ],
    [
      'failure and undecided together',
      [step({ stepId: 'a', assertions: [fail(), undecided()] })],
      DEFAULT_POLICY,
    ],
    [
      'an escalating capture warning',
      [step({ stepId: 'a', assertions: [pass()], changes: changes([{ code: 'scope-truncated', message: 'cut short' }]) })],
      DEFAULT_POLICY,
    ],
    [
      'a tolerated capture warning',
      [step({ stepId: 'a', assertions: [pass()], changes: changes([{ code: 'concurrent-writes-detected', message: 'sessions' }]) })],
      DEFAULT_POLICY,
    ],
    ['a step that checked nothing', [step({ stepId: 'a' })], DEFAULT_POLICY],
    ['a step never reached', [step({ stepId: 'a', status: 'skipped' })], DEFAULT_POLICY],
  ];

  for (const [label, steps, policy] of combinations) {
    it(`agrees for ${label}`, () => {
      const envelope = envelopeFor(steps, policy);
      const xmlText = toJUnit(envelope);

      // The XML's own worst case, derived from the same table that rendered it.
      assert.equal(
        exitCodeOf(outcomeFromCases(envelope)),
        envelope.exitCode,
        `${label}: the file says ${outcomeFromCases(envelope)}, the shell says ${envelope.exitCode}`,
      );

      // And the file must not look clean when the exit code is not.
      const red = /<failure|<error/.test(xmlText);
      assert.equal(
        red,
        envelope.exitCode !== 0,
        `${label}: exit ${envelope.exitCode} but the XML is ${red ? 'red' : 'green'}`,
      );
    });
  }
});

// ─── the undecided mapping ────────────────────────────────────────────────────

describe('undecided assertions', () => {
  it('render as <error>, never <skipped> or a bare pass', () => {
    // <skipped> is rendered green by real consumers, and NUnit's own converter
    // turns Inconclusive into an indistinguishable pass. <error> is the only
    // element that means "no verdict" everywhere.
    const xmlText = toJUnit(envelopeFor([step({ stepId: 'a', assertions: [undecided()] })]));
    assert.match(xmlText, /<error type="tuplescope\.unevaluable"/);
    assert.doesNotMatch(xmlText, /<skipped type="tuplescope\.unevaluable"/);
  });

  it('say in the body that this is neither a pass nor a failure', () => {
    // <error message> is often all a dashboard shows, and a reader who has only
    // seen two states will file this as one of them unless told.
    const xmlText = toJUnit(envelopeFor([step({ stepId: 'a', assertions: [undecided()] })]));
    assert.match(xmlText, /did NOT run\. It is neither a pass nor a failure/);
    assert.match(xmlText, /single\(\) expected exactly one row, found 2/);
    assert.match(xmlText, /Nothing here says the system under test is wrong/);
  });

  it('drop to <skipped> only when the operator declared they accept it', () => {
    const xmlText = toJUnit(
      envelopeFor([step({ stepId: 'a', assertions: [undecided()] })], {
        ...DEFAULT_POLICY,
        unevaluable: 'warn',
      }),
    );
    assert.match(xmlText, /<skipped type="tuplescope\.unevaluable"/);
    // Demoted, never removed.
    assert.match(xmlText, /single\(\) expected exactly one row/);
  });

  it('degrades an outcome it does not recognise to undecided', () => {
    const unknown = mapAssertion(
      { source: 'x', outcome: 'invented-in-v0.9' as never },
      DEFAULT_POLICY,
    );
    assert.equal(unknown.element, 'error');
    assert.equal(unknown.contributes, 'undecided');
    // The same rule for a reader parsing someone else's envelope.
    assert.equal(readAssertionOutcome('invented-in-v0.9'), 'unevaluable');
    assert.equal(readAssertionOutcome('passed'), 'passed');
    assert.equal(readStepOutcome('who-knows'), 'undecided');
  });
});

// ─── well-formedness ──────────────────────────────────────────────────────────

describe('the file itself', () => {
  it('escapes everything an assertion source can contain', () => {
    // `a < b & c > d 'e'` in a name would produce a file no CI parser reads,
    // which the user experiences as TupleScope having produced nothing at all.
    const nasty = 'single(t).after.note == "a < b & c > d \'e\'"';
    const xmlText = toJUnit(envelopeFor([step({ stepId: 'a', assertions: [fail(nasty)] })]));
    assert.match(xmlText, /&quot;a &lt; b &amp; c &gt; d &apos;e&apos;&quot;/);

    // Every `&` must open a known entity — a bare one is what breaks parsers.
    const bare = [...xmlText.matchAll(/&(?!(amp|lt|gt|quot|apos);)/g)];
    assert.equal(bare.length, 0, `${bare.length} unescaped ampersand(s)`);

    // And no raw angle bracket may survive inside an attribute value.
    for (const match of xmlText.matchAll(/="([^"]*)"/g)) {
      assert.doesNotMatch(match[1]!, /[<>]/, `unescaped bracket in attribute: ${match[1]}`);
    }
  });

  it('survives a control character in a captured value', () => {
    // A database value can carry one, and it is illegal in XML 1.0 even when
    // escaped — one would otherwise poison the entire file.
    const xmlText = toJUnit(
      envelopeFor([
        step({
          stepId: 'a',
          assertions: [{ source: 'x == 1', status: 'failed', actual: 'a\u0007b', expected: '1' }],
        }),
      ]),
    );
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(xmlText, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    assert.match(xmlText, /\\x07/);
  });

  it('counts tests, failures, errors and skips consistently', () => {
    const envelope = envelopeFor([
      step({ stepId: 'a', assertions: [pass(), fail(), undecided()] }),
      step({ stepId: 'b', status: 'skipped' }),
    ]);
    const xmlText = toJUnit(envelope);
    assert.equal(attr(xmlText, 'tests'), '4');
    assert.equal(attr(xmlText, 'failures'), '1');
    assert.equal(attr(xmlText, 'errors'), '1');
    assert.equal(attr(xmlText, 'skipped'), '1');
  });

  it('puts a step wall clock on its first assertion only', () => {
    // So the sum stays equal to the truth without inventing per-assertion times.
    const xmlText = toJUnit(envelopeFor([step({ stepId: 'a', assertions: [pass('one'), pass('two')] })]));
    const times = [...xmlText.matchAll(/<testcase [^>]*time="([\d.]+)"/g)].map((m) => m[1]);
    assert.deepEqual(times, ['0.500', '0.000']);
  });

  it('records what a reader needs to recover the run', () => {
    const xmlText = toJUnit(envelopeFor([step({ stepId: 'a', assertions: [pass()] })]));
    for (const name of [
      'tuplescope.schema',
      'tuplescope.runId',
      'tuplescope.outcome',
      'tuplescope.proves',
      'tuplescope.captureMethod',
      'tuplescope.baseline',
      'tuplescope.unevaluable',
    ]) {
      assert.match(xmlText, new RegExp(`name="${name.replace('.', '\\.')}"`), `missing ${name}`);
    }
  });

  it('says when the baseline was never probed', () => {
    const xmlText = toJUnit(
      envelopeFor([step({ stepId: 'a', assertions: [pass()] })], DEFAULT_POLICY, {
        baseline: { probed: false, windowMs: 0 },
      }),
    );
    assert.match(xmlText, /name="tuplescope\.baseline" value="not-probed"/);
  });

  it('shows a capture warning as its own case', () => {
    const xmlText = toJUnit(
      envelopeFor([
        step({
          stepId: 'a',
          assertions: [pass()],
          changes: changes([{ code: 'concurrent-writes-detected', table: 'sessions', message: 'wrote' }]),
        }),
      ]),
    );
    assert.match(xmlText, /name="concurrent-writes-detected \(sessions\)"/);
  });
});

// ─── the envelope ─────────────────────────────────────────────────────────────

describe('summariseChanges', () => {
  it('counts a write with no visible change separately', () => {
    // The product's whole differentiator would otherwise vanish into a zero.
    const set: ChangeSet = {
      ...changes(),
      changes: [
        {
          table: 'refunds',
          key: null,
          kind: 'update',
          before: { id: visible('text', 'r1') },
          after: { id: visible('text', 'r1') },
          changedColumns: [],
          visibleColumns: [],
          hasWrite: true,
        },
      ],
    };
    const summary = summariseChanges(set);
    assert.equal(summary.tables[0]?.updated, 1);
    assert.equal(summary.tables[0]?.writtenNoVisibleChange, 1);
  });

  it('omits rows unless asked, and includes them when asked', () => {
    const set: ChangeSet = {
      ...changes(),
      changes: [
        {
          table: 't',
          key: null,
          kind: 'insert',
          before: null,
          after: { id: visible('text', '1') },
          changedColumns: ['id'],
          visibleColumns: ['id'],
          hasWrite: true,
        },
      ],
    };
    assert.equal(summariseChanges(set).rows, undefined);
    assert.equal(summariseChanges(set, true).rows?.length, 1);
  });
});

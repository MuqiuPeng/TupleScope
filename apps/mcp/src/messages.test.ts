/**
 * The sentences several tools share, pinned without starting a server.
 *
 * Each was measured saying less than it should, or more: a table described
 * with the workspace's mask list instead of its own columns, and with no types;
 * a refusal that named a miss and not what exists; a temporary path handed to
 * an agent as if it were a file it could go and look at; a clean run headed
 * "every assertion evaluated and passed" above two undecided ones; a red run
 * returned as a plain result; a keyless table listed like any other.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_POLICY,
  mergeVerdicts,
  verdictOf,
  type AssertionStatus,
  type Run,
  type RunOutcome,
  type StepResult,
} from '@tuplescope/core';
import {
  describeScope,
  describeTable,
  describeVerdict,
  noSuchScenario,
  noSuchStep,
  notWritten,
  runIsError,
} from './messages.js';

const WALLETS = {
  table: 'wallets',
  keyStrategy: 'primary-key',
  columns: [
    { name: 'id', type: 'text' },
    { name: 'balance', type: 'numeric(18,8)' },
    { name: 'updatedAt', type: 'timestamp(3) without time zone' },
  ],
  ignoreColumns: ['updatedAt'],
  maskColumns: ['passwordHash', 'tokenHash'],
  capture: { method: 'mvcc-xmin', detection: 'write', fidelity: 'net' },
} as const;

describe('describeTable', () => {
  it('applies the mask list to this table, not the workspace', () => {
    // Measured: `masked  passwordHash, tokenHash` on `wallets`, which has
    // neither column.
    const text = describeTable(WALLETS);
    assert.match(text, /^ {2}masked {8}\(none\)$/m);
    assert.doesNotMatch(text, /passwordHash|tokenHash/);
  });

  it('computes ignored the same way, from the workspace list', () => {
    // ...while `ignored` read `(none)` beside the `updatedAt` it does ignore.
    assert.match(describeTable(WALLETS), /^ {2}ignored {7}updatedAt$/m);
    assert.match(describeTable({ ...WALLETS, columns: [{ name: 'id', type: 'text' }] }), /^ {2}ignored {7}\(none\)$/m);
  });

  it('lists every column with its declared type, in table order, and marks it', () => {
    // It printed names only, "names only; this build does not report their
    // types", under a description that had promised types.
    const text = describeTable({ ...WALLETS, maskColumns: ['balance'] });
    assert.match(text, /^ {2}columns \(3\), in table order, with their declared types$/m);
    assert.doesNotMatch(text, /names only|does not report/);
    const listed = text.split('\n').filter((line) => line.startsWith('    '));
    assert.deepEqual(listed, [
      `    id${' '.repeat(9)}text`,
      `    balance${' '.repeat(4)}numeric(18,8)${' '.repeat(19)}masked`,
      '    updatedAt  timestamp(3) without time zone  ignored',
    ]);
  });

  it('still says a keyless table can be counted but not matched', () => {
    assert.match(
      describeTable({ ...WALLETS, keyStrategy: 'full-row-multiset' }),
      /row identity {2}full-row-multiset — no primary key or unique index/,
    );
  });
});

// ─── verdicts ─────────────────────────────────────────────────────────────────

const T0 = '2026-01-01T00:00:00.000Z';

/** One step carrying these assertion results, through the real verdict. */
function runOf(statuses: ReadonlyArray<AssertionStatus>): Run {
  const step: StepResult = {
    stepId: 'confirm',
    name: 'Confirm',
    status: 'passed',
    startedAt: T0,
    request: {} as StepResult['request'],
    assertions: statuses.map((status, index) => ({ source: `assertion ${index}`, status })),
  };
  return {
    id: 'run_1',
    scenarioId: 'probe',
    datasetId: 'ordering',
    coverage: 'full',
    startedAt: T0,
    status: 'passed',
    baseline: { probed: true, windowMs: 400 },
    steps: [step],
    variables: {},
  };
}

const WARN = { ...DEFAULT_POLICY, unevaluable: 'warn' } as const;

describe('describeVerdict', () => {
  it('heads a clean run under unevaluable "warn" with what was decided, not "every assertion"', () => {
    // Measured through run_scenario: "CLEAN (exit 0) — every assertion
    // evaluated and passed." directly above "assertions: 2 passed, 0 failed,
    // 2 undecided, of 4."
    const verdict = verdictOf(runOf(['passed', 'passed', 'unevaluable', 'unevaluable']), WARN);
    assert.equal(verdict.outcome, 'clean');
    const [head, counts] = describeVerdict(verdict).split('\n');
    assert.equal(
      head,
      'CLEAN (exit 0) — 2 of 4 assertions evaluated and passed; 2 could not be evaluated and were ' +
        'not counted against this run, by policy.',
    );
    assert.equal(counts, 'assertions: 2 passed, 0 failed, 2 undecided, of 4.');
  });

  it('says they all passed only when every one was decided', () => {
    const [head] = describeVerdict(verdictOf(runOf(['passed', 'passed']))).split('\n');
    assert.equal(head, 'CLEAN (exit 0) — 2 assertions evaluated and passed.');
  });

  it('speaks a one-dataset suite, which is what run_scenario hands it, in the same words', () => {
    const verdict = verdictOf(runOf(['passed', 'unevaluable']), WARN);
    const [head] = describeVerdict(mergeVerdicts([verdict], WARN)).split('\n');
    assert.match(head ?? '', /^CLEAN \(exit 0\) — 1 of 2 assertions evaluated and passed; 1 could not be evaluated and was not counted/);
  });

  it('still opens an undecided run by saying it is not a pass', () => {
    const [head] = describeVerdict(verdictOf(runOf(['passed', 'unevaluable']))).split('\n');
    assert.match(head ?? '', /^UNDECIDED \(exit 3\) — this is NOT a pass and NOT a failure\./);
  });
});

describe('runIsError', () => {
  it('is an error result for every outcome but clean', () => {
    // run_scenario returned isError=false for FAILED (exit 1) and UNDECIDED
    // (exit 3) alike, measured against the payment service.
    const outcomes: RunOutcome[] = ['clean', 'failed', 'errored', 'undecided'];
    assert.deepEqual(Object.fromEntries(outcomes.map((outcome) => [outcome, runIsError(outcome)])), {
      clean: false,
      failed: true,
      errored: true,
      undecided: true,
    });
  });

  it('follows the verdict a run actually reaches, policy included', () => {
    assert.equal(runIsError(verdictOf(runOf(['passed', 'failed'])).outcome), true);
    assert.equal(runIsError(verdictOf(runOf(['passed', 'unevaluable'])).outcome), true);
    // Let through by policy, and said so in the head: not an error result.
    assert.equal(runIsError(verdictOf(runOf(['passed', 'unevaluable']), WARN).outcome), false);
  });
});

// ─── the scope ────────────────────────────────────────────────────────────────

const NOTHING_HIDDEN = {
  otherSchemas: [],
  nameFiltered: [],
  partitionedParents: [],
  foreignTables: [],
  keyless: [],
} as const;

describe('describeScope', () => {
  it('says nothing when nothing is out of sight', () => {
    assert.deepEqual(describeScope(NOTHING_HIDDEN), []);
  });

  it('names a keyless table as a gap, with what it costs where a delete cannot be seen', () => {
    // describe_workspace listed `ts_fix2_keyless` among the tables it can
    // observe, like any other; a run there refuses `hasWrite(changes(*))`.
    const lines = describeScope({
      ...NOTHING_HIDDEN,
      keyless: [{ table: 'ts_fix2_keyless', departuresObservable: false }],
    });
    assert.equal(lines.length, 1);
    const [line = ''] = lines;
    assert.match(line, /^keyless {5}ts_fix2_keyless — no primary key or unique index/);
    assert.match(line, /a change arrives as an insert, and a delete is not seen at all/);
    assert.match(line, /over updated\(\.\.\.\) or deleted\(\.\.\.\) of it come back undecided/);
    assert.match(line, /every table \(changes\(\*\)\) in a scenario with no `watch:` list unless they say `except ts_fix2_keyless`/);
    assert.match(line, /degraded-row-identity warning/);
    assert.match(line, /Give it a primary key or a unique index\.$/);
  });

  it('does not claim a capture that sees deletes misses them', () => {
    const [line = ''] = describeScope({ ...NOTHING_HIDDEN, keyless: [{ table: 'audit', departuresObservable: true }] });
    assert.match(line, /^keyless {5}audit — no primary key or unique index/);
    assert.match(line, /an update is reported as a delete and an insert/);
    assert.doesNotMatch(line, /not seen|undecided/);
  });

  it('groups several keyless tables, and names each in the remedy', () => {
    const [line = ''] = describeScope({
      ...NOTHING_HIDDEN,
      keyless: [
        { table: 'a', departuresObservable: false },
        { table: 'b', departuresObservable: false },
      ],
    });
    assert.match(line, /^keyless {5}a, b — /);
    assert.match(line, /of them come back undecided/);
    assert.match(line, /`except a, b`/);
    assert.match(line, /Give each a primary key/);
  });

  it('names the gaps `status` and `check` name', () => {
    assert.deepEqual(
      describeScope({
        ...NOTHING_HIDDEN,
        otherSchemas: [{ schema: 'billing', tables: 2 }],
        nameFiltered: ['_prisma_migrations'],
        foreignTables: ['remote_rates'],
        partitionedParents: ['events'],
      }),
      [
        'not watched billing (2 tables, another schema) · _prisma_migrations (name begins with _) · remote_rates (foreign table)',
        'partitioned events — watched through their partitions, not under this name',
      ],
    );
  });
});

// ─── refusals ─────────────────────────────────────────────────────────────────

describe('noSuchScenario', () => {
  it('names the miss and every id there is', () => {
    assert.equal(noSuchScenario('nosuch', ['guards', 'topup']), 'No scenario `nosuch`. There is: guards, topup.');
    assert.equal(noSuchScenario('nosuch', []), 'No scenario `nosuch`. There is: (none).');
  });
});

describe('noSuchStep', () => {
  const scenario = {
    id: 'topup',
    datasets: [
      { id: 'happy', steps: [{ id: 'create' }, { id: 'confirm' }] },
      { id: 'twice', steps: [{ id: 'create' }] },
    ],
  };

  it('lists the datasets when the dataset is the miss', () => {
    assert.equal(
      noSuchStep(scenario, 'hapy', 'create'),
      'Scenario `topup` has no dataset `hapy`. It has: happy, twice.',
    );
  });

  it('lists the steps when the step is the miss', () => {
    assert.equal(
      noSuchStep(scenario, 'happy', 'confrim'),
      'Dataset `topup/happy` has no step `confrim`. It has: create, confirm.',
    );
  });

  it('says nothing when both exist', () => {
    assert.equal(noSuchStep(scenario, 'happy', 'confirm'), undefined);
  });
});

describe('notWritten', () => {
  const where = {
    temp: '/ws/scenarios/x.yaml.mcp-tmp',
    file: '/ws/scenarios/x.yaml',
    scenariosDir: '/ws/scenarios',
    configFile: '/ws/tuplescope.yaml',
  };

  it('turns a missing scenarios directory into the fix, without the temporary path', () => {
    const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${where.temp}'`), {
      code: 'ENOENT',
    });
    const text = notWritten(error, where);
    assert.equal(
      text,
      'Not written — there is no scenarios directory at /ws/scenarios.\n\n' +
        'Create it, or point `scenariosDir` somewhere else in /ws/tuplescope.yaml.',
    );
  });

  it('names the real file, not the temporary one, for any other failure', () => {
    const error = Object.assign(new Error(`EACCES: permission denied, open '${where.temp}'`), { code: 'EACCES' });
    const text = notWritten(error, where);
    assert.doesNotMatch(text, /mcp-tmp/);
    assert.match(text, /permission denied, open '\/ws\/scenarios\/x\.yaml'/);
  });
});

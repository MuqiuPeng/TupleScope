/**
 * The checks that exist because what they catch otherwise stays green forever.
 *
 * Every case here is a suite that runs, passes, and establishes nothing. That is
 * the failure `check` exists to prevent, and until this file there was no test
 * of it anywhere — the logic lived twice, inline in two command handlers, each
 * reachable only through a process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditScenarios, formatProblem, type AuditTarget } from './audit.js';

const schema = {
  tables: new Set(['payments', 'wallets', 'ledger_entries']),
  columns: new Map([
    ['payments', new Set(['id', 'status', 'amount'])],
    ['wallets', new Set(['id', 'balance'])],
    ['ledger_entries', new Set(['id', 'type'])],
  ]),
};

const target = (...assertions: string[]): AuditTarget[] => [
  {
    scenario: { id: 'refund', title: 'T', datasets: [] } as never,
    dataset: {
      id: 'happy',
      steps: [{ id: 'pay', name: 'Pay', request: { method: 'POST', path: '/p' }, assert: assertions }],
    } as never,
  },
];

const messages = (...assertions: string[]): string[] =>
  auditScenarios(target(...assertions), schema).problems.map((p) => p.message);

describe('names that do not resolve', () => {
  it('catches a misspelled table', () => {
    assert.deepEqual(messages('count(inserted(walets)) == 0'), [
      'names table `walets`, which is not in this database',
    ]);
  });

  it('catches one behind the bare-table shorthand', () => {
    // No `changes(` in the source at all — the shorthand becomes a selector
    // during parsing. The regex this replaced could not see it, and this is
    // exactly the form `promote` writes for a cross-row invariant.
    assert.deepEqual(messages('sum(delta(walets.balance)) == "0.00"'), [
      'names table `walets`, which is not in this database',
    ]);
  });

  it('catches a misspelled predicate column, which is the one that never fails loudly', () => {
    // The evaluator resolves predicate columns only when it has a row, and a
    // step that writes nothing never gives it one. `count(inserted(t).where(nmae
    // = "x")) == 0` is the shape of every "must not write twice" guard.
    assert.deepEqual(messages('count(inserted(payments).where(nmae = "x")) == 0'), [
      'matches on `payments.nmae`, which is not a column of `payments`',
    ]);
  });

  it('catches an except that excludes nothing', () => {
    assert.deepEqual(messages('hasWrite(changes(* except audti_log)) == false'), [
      'excepts `audti_log`, which is not a table here — so it excludes nothing',
    ]);
  });

  it('does not report a column twice for a table it has already rejected', () => {
    const out = messages('count(inserted(walets).where(blance = "1")) == 0');
    assert.equal(out.length, 1, out.join(' | '));
    assert.match(out[0]!, /names table/);
  });

  it('says nothing about a suite that resolves', () => {
    assert.deepEqual(
      messages(
        'count(inserted(payments)) == 1',
        'single(updated(wallets, id = "w1")).after.balance == "0.00"',
        'hasWrite(changes(* except ledger_entries)) == false',
      ),
      [],
    );
  });

  it('skips an assertion it cannot parse, leaving that to the run', () => {
    // `run` reports a syntax error with a position; guessing here would produce
    // a second, worse message about the same line.
    assert.deepEqual(messages('count(inserted(payments) =='), []);
  });
});

describe('steps that establish nothing', () => {
  it('counts a step with no assertions, and says so', () => {
    const result = auditScenarios(target(), schema);
    assert.equal(result.unchecked, 1);
    assert.equal(result.assertions, 0);
    assert.match(result.problems[0]!.message, /checks nothing/);
  });

  it('counts assertions across the selection, so a caller can refuse a suite of zero', () => {
    // Both callers use this to refuse the green sentence over a suite that
    // asserts nothing — the failure the command exists to prevent.
    assert.equal(auditScenarios(target('count(inserted(payments)) == 1'), schema).assertions, 1);
    assert.equal(auditScenarios([], schema).assertions, 0);
  });
});

describe('the reported location', () => {
  it('carries scenario, dataset and step, so a caller can format its own way', () => {
    const [problem] = auditScenarios(target('count(inserted(nope)) == 0'), schema).problems;
    assert.deepEqual(
      { s: problem!.scenarioId, d: problem!.datasetId, st: problem!.stepId },
      { s: 'refund', d: 'happy', st: 'pay' },
    );
    assert.equal(
      formatProblem(problem!, '  '),
      '  refund/happy/pay  names table `nope`, which is not in this database',
    );
  });
});

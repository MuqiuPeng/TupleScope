import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, Detection, Row, RowChange, Value } from '@statescope/core';
import { parse } from './parse.js';
import { evaluateAssertion, Unevaluable, valuesEqual } from './evaluate.js';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const v = (text: string | null, pgType = 'text'): Value => ({ pgType, text });
const money = (text: string): Value => v(text, 'numeric');

function row(values: Record<string, Value>): Row {
  return values;
}

function change(partial: Partial<RowChange> & Pick<RowChange, 'table' | 'kind'>): RowChange {
  const before = partial.before ?? null;
  const after = partial.after ?? null;
  const changedColumns =
    partial.changedColumns ??
    Object.keys(after ?? before ?? {}).filter(
      (c) => (before?.[c]?.text ?? null) !== (after?.[c]?.text ?? null),
    );
  return {
    key: null,
    before,
    after,
    changedColumns,
    visibleColumns: partial.visibleColumns ?? changedColumns,
    hasWrite: partial.hasWrite ?? true,
    ...partial,
  };
}

function changeSet(changes: RowChange[], detection: Detection = 'write'): ChangeSet {
  const tables = [...new Set(changes.map((c) => c.table))];
  return {
    captureMethod: detection === 'write' ? 'mvcc-xmin' : 'snapshot-diff',
    detection,
    scope: {
      allTables: true,
      tables: tables.map((table) => ({
        table,
        ignoreColumns: [],
        maskedColumns: [],
        keyStrategy: 'primary-key',
      })),
    },
    changes,
    warnings: [],
    durationMs: 1,
  };
}

const check = (source: string, changes: ChangeSet, variables: Record<string, string> = {}) =>
  evaluateAssertion(parse(source), { changes, variables });

// A refund: the payment flips status, both wallets move, two ledger legs land.
const REFUND = changeSet([
  change({
    table: 'payments',
    kind: 'update',
    before: row({ id: v('pay_1'), status: v('COMPLETED') }),
    after: row({ id: v('pay_1'), status: v('REFUNDED') }),
  }),
  change({
    table: 'wallets',
    kind: 'update',
    before: row({ id: v('wal_alice'), balance: money('900.00') }),
    after: row({ id: v('wal_alice'), balance: money('1000.00') }),
  }),
  change({
    table: 'wallets',
    kind: 'update',
    before: row({ id: v('wal_shop'), balance: money('100.00') }),
    after: row({ id: v('wal_shop'), balance: money('0.00') }),
  }),
  change({
    table: 'ledger_entries',
    kind: 'insert',
    after: row({ id: v('1'), type: v('REVERSAL'), amount: money('100.00') }),
  }),
  change({
    table: 'ledger_entries',
    kind: 'insert',
    after: row({ id: v('2'), type: v('REVERSAL'), amount: money('-100.00') }),
  }),
]);

// ─── value semantics ──────────────────────────────────────────────────────────

describe('valuesEqual', () => {
  it('compares jsonb structurally, because Postgres reorders keys', () => {
    // Written as {"b":2,"a":1}, read back as {"a": 1, "b": 2}. A string compare
    // would invent a change that never happened.
    const a = v('{"b": 2, "a": 1}', 'jsonb');
    const b = v('{"a": 1, "b": 2}', 'jsonb');
    assert.ok(valuesEqual(a, b));
    assert.equal(valuesEqual(a, v('{"a": 1, "b": 3}', 'jsonb')), false);
  });

  it('compares nested json structurally', () => {
    assert.ok(
      valuesEqual(
        v('{"m":{"y":2,"x":1},"l":[1,2]}', 'jsonb'),
        v('{"l":[1,2],"m":{"x":1,"y":2}}', 'jsonb'),
      ),
    );
  });

  it('does not treat array order as insignificant', () => {
    assert.equal(valuesEqual(v('[1,2]', 'jsonb'), v('[2,1]', 'jsonb')), false);
  });

  it('compares numeric by value, not by text', () => {
    assert.ok(valuesEqual(money('1.10'), money('1.1')));
    assert.equal(valuesEqual(money('1.10'), money('1.11')), false);
  });

  it('compares citext case-insensitively and text case-sensitively', () => {
    assert.ok(valuesEqual(v('Alice', 'citext'), v('alice', 'citext')));
    assert.equal(valuesEqual(v('Alice'), v('alice')), false);
  });

  it('treats NULL as equal only to NULL', () => {
    assert.ok(valuesEqual(v(null), v(null)));
    assert.equal(valuesEqual(v(null), v('')), false);
  });

  it('falls back to text when jsonb will not parse', () => {
    assert.ok(valuesEqual(v('not json', 'jsonb'), v('not json', 'jsonb')));
  });
});

// ─── selection and aggregation ────────────────────────────────────────────────

describe('evaluate', () => {
  it('reads a column off a single selected row', () => {
    assert.ok(check('single(updated(payments)).after.status == "REFUNDED"', REFUND).passed);
    assert.ok(check('single(updated(payments)).before.status == "COMPLETED"', REFUND).passed);
  });

  it('counts inserts, and filters them by predicate', () => {
    assert.ok(check('count(inserted(ledger_entries)) == 2', REFUND).passed);
    assert.ok(
      check('count(inserted(ledger_entries).where(type = "REVERSAL")) == 2', REFUND).passed,
    );
    assert.ok(check('count(inserted(ledger_entries).where(type = "PAYMENT")) == 0', REFUND).passed);
  });

  it('computes an exact delta over a numeric column', () => {
    assert.ok(
      check('delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"', REFUND).passed,
    );
    assert.ok(
      check('delta(single(rows(wallets, id = "wal_shop")).balance) == "-100.00"', REFUND).passed,
    );
  });

  it('sums deltas across rows, so a double entry nets to zero', () => {
    assert.ok(check('sum(delta(wallets.balance)) == "0.00"', REFUND).passed);
    assert.ok(check('sum(delta(wallets.balance)) == 0', REFUND).passed);
  });

  it('substitutes captured variables', () => {
    const changes = changeSet([
      change({ table: 'refunds', kind: 'insert', after: row({ id: v('ref_9') }) }),
    ]);
    assert.ok(
      check('single(inserted(refunds)).after.id == {{refund_id}}', changes, {
        refund_id: 'ref_9',
      }).passed,
    );
  });

  it('reports the left-hand side on failure, not the verdict', () => {
    // "expected 2, got 5" is actionable; "got false" sends you to psql.
    const result = check('count(inserted(ledger_entries)) == 5', REFUND);
    assert.equal(result.passed, false);
    assert.equal(result.actual, '2');
    assert.equal(result.expected, '5');
  });
});

// ─── the refusals ─────────────────────────────────────────────────────────────

describe('refusals', () => {
  const fails = (source: string, changes: ChangeSet, pattern: RegExp) =>
    assert.throws(() => check(source, changes), (e: unknown) => {
      assert.ok(e instanceof Unevaluable, `expected Unevaluable, got ${String(e)}`);
      assert.match(e.message, pattern);
      return true;
    });

  it('refuses a mutation count under value detection', () => {
    // A value comparison cannot distinguish a redundant write from no write, so
    // counting mutations against one is not a fail — it is unanswerable.
    fails('count(inserted(payments)) == 1', changeSet(REFUND.changes, 'value'), /write detection/);
  });

  it('refuses hasWrite under value detection', () => {
    fails('hasWrite(changes(*)) == false', changeSet([], 'value'), /write detection/);
  });

  it('refuses single() when the match is not exactly one row', () => {
    fails('single(updated(wallets)).after.balance == 1', REFUND, /expected exactly one row, found 2/);
    fails('single(deleted(payments)).after.id == 1', REFUND, /found 0/);
  });

  it('refuses a column with no stated side', () => {
    fails('single(updated(payments)).status == "REFUNDED"', REFUND, /needs a side/);
  });

  it('refuses a table outside the watch scope', () => {
    const scoped: ChangeSet = {
      ...REFUND,
      scope: {
        allTables: false,
        tables: [{ table: 'payments', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' }],
      },
    };
    fails('count(inserted(refunds)) == 1', scoped, /not being watched/);
  });

  it('refuses a delta over a non-numeric column', () => {
    fails('delta(single(updated(payments)).status) == 1', REFUND, /not numeric/);
  });

  it('refuses comparing a many-valued column without an aggregate', () => {
    fails('delta(wallets.balance) == "0.00"', REFUND, /needs one value/);
  });

  it('refuses an unknown variable rather than treating it as a literal', () => {
    fails('single(updated(payments)).after.id == {{nope}}', REFUND, /no variable `nope`/);
  });
});

// ─── hasWrite: the point of the whole thing ───────────────────────────────────

describe('hasWrite', () => {
  it('is true for a write that changed no value at all', () => {
    // UPDATE t SET created_at = created_at. Zero columns differ; the row was
    // still rewritten. This is the case a value diff cannot see.
    const invisible = changeSet([
      change({
        table: 'refunds',
        kind: 'update',
        before: row({ id: v('ref_1'), amount: money('100.00') }),
        after: row({ id: v('ref_1'), amount: money('100.00') }),
        hasWrite: true,
      }),
    ]);
    assert.deepEqual(invisible.changes[0]!.changedColumns, []);
    assert.equal(check('hasWrite(changes(*)) == false', invisible).passed, false);
  });

  it('is false when nothing was touched', () => {
    assert.ok(check('hasWrite(changes(*)) == false', changeSet([])).passed);
    assert.ok(check('changes(*).isEmpty()', changeSet([])).passed);
  });

  it('does not confuse an ignored column with an absent write', () => {
    // visibleColumns is empty because updated_at is ignored; hasWrite is not.
    const touched = changeSet([
      change({
        table: 'refunds',
        kind: 'update',
        before: row({ id: v('ref_1'), updated_at: v('t0') }),
        after: row({ id: v('ref_1'), updated_at: v('t1') }),
        visibleColumns: [],
        hasWrite: true,
      }),
    ]);
    assert.equal(check('hasWrite(changes(*)) == false', touched).passed, false);
    // ...while the diff view would correctly show nothing worth reading.
    assert.deepEqual(touched.changes[0]!.visibleColumns, []);
  });
});

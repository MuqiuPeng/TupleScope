import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, Detection, Row, RowChange, Value, VisibleValue } from '@statescope/core';
import { parse } from './parse.js';
import {
  Unevaluable,
  evaluateAssertion,
  predicateColumnsIn,
  valuesEqual,
} from './evaluate.js';
import { textIfVisible, visible } from '@statescope/core';

// ─── fixtures ─────────────────────────────────────────────────────────────────

// Returns the visible arm, because that is what these fixtures are: values
// this run has. `valuesEqual` only accepts those, by design.
const v = (text: string | null, pgType = 'text'): VisibleValue => visible(pgType, text);
const money = (text: string): VisibleValue => v(text, 'numeric');

function row(values: Record<string, Value>): Row {
  return values;
}

function change(partial: Partial<RowChange> & Pick<RowChange, 'table' | 'kind'>): RowChange {
  const before = partial.before ?? null;
  const after = partial.after ?? null;
  const changedColumns =
    partial.changedColumns ??
    Object.keys(after ?? before ?? {}).filter(
      (c) => (textIfVisible(before?.[c]) ?? null) !== (textIfVisible(after?.[c]) ?? null),
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

function changeSet(changes: readonly RowChange[], detection: Detection = 'write'): ChangeSet {
  const tables = [...new Set(changes.map((c) => c.table))];
  return {
    captureMethod: detection === 'write' ? 'mvcc-xmin' : 'snapshot-diff',
    detection,
    fidelity: 'net',
    scope: {
      schema: 'public',
      database: 'test',
      allTables: true,
      tables: tables.map((table) => ({
        table,
        ignoreColumns: [],
        maskedColumns: [],
        keyStrategy: 'primary-key',
      })),
    },
    changes,
    // Required, so a ChangeSet cannot exist without saying how its text was printed.
    rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
    warnings: [],
    durationMs: 1,
  };
}

/**
 * `rows(...)` reads the rows as they are now, so a test that uses it has to say
 * what is there — the same as production, where the engine reads them through
 * the adapter.
 *
 * Answering from the change set instead is exactly the bug this closed: the
 * change set knowing about one matching row does not mean the table holds one,
 * and `count(rows(t, pred)) == 0` passed over rows that plainly existed.
 */
const check = (
  source: string,
  changes: ChangeSet,
  variables: Record<string, string> = {},
  present: ReadonlyArray<RowChange> = changes.changes,
) =>
  evaluateAssertion(parse(source), {
    changes,
    variables,
    lookupRows: (table, predicate) => ({
      complete: true,
      rows: present
        .filter((c) => !table || c.table === table)
        .filter((c) => !predicate || matchesForTest(c, predicate))
        .map((c) => ({ ...c, kind: 'unchanged' as const, before: c.after ?? c.before })),
    }),
  });

/** The same `col = "value"` matching the evaluator does, for the fake above. */
function matchesForTest(change: RowChange, predicate: string): boolean {
  const row = change.after ?? change.before;
  if (!row) return false;
  return predicate.split(/\s*(?:,|\band\b)\s*/).every((clause) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]?(.*?)['"]?\s*$/.exec(clause);
    return m ? (textIfVisible(row[m[1]!]) ?? null) === m[2] : false;
  });
}

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

  it('refuses to count updates under value detection, but not inserts', () => {
    // The distinction is what a value comparison can miss. A row that is there
    // or not is a value-level fact, so inserts count exactly. A row rewritten
    // to the same values is invisible, so an update count is a floor — and a
    // floor returned as a number, with nothing marking it as one, is how an
    // idempotency check passes over the write it was meant to catch.
    const seen = changeSet(REFUND.changes, 'value');
    fails('count(updated(payments)) == 1', seen, /write detection/);
    fails('count(changes(*)) == 1', seen, /write detection/);
    assert.equal(check('count(inserted(ledger_entries)) == 2', seen).passed, true);
  });

  it('refuses isEmpty and any over changes under value detection', () => {
    // Same reduction, same hazard, and this is the confident direction:
    // `isEmpty(changes(*)) == true` would read as "nothing was written".
    const seen = changeSet(REFUND.changes, 'value');
    fails('isEmpty(changes(*)) == true', seen, /write detection/);
    fails('any(updated(payments)) == true', seen, /write detection/);
    // Over inserts it stays answerable, because absence of a row is observable.
    assert.equal(check('isEmpty(inserted(ledger_entries)) == false', seen).passed, true);
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

  it('refuses a table name that does not exist, even with no watch list', () => {
    // The forbidden green, in its purest form: `paymnets` is a typo for
    // `payments`, the table does not exist, the selection is empty, the count
    // is 0, and `== 0` passes. A misspelled table name used to satisfy an
    // assertion and turn a CI job green.
    //
    // `allTables: true` says the scope was not narrowed. It says nothing about
    // whether the name in the assertion is real, and short-circuiting on it was
    // the bug.
    fails('count(inserted(paymnets)) == 0', REFUND, /no table `paymnets` in this database/);
  });

  it('names the table the author probably meant', () => {
    assert.throws(() => check('count(inserted(paymnets)) == 0', REFUND), (e: unknown) => {
      assert.match((e as Error).message, /did you mean `payments`\?/);
      return true;
    });
    // A transposition and a missing letter both count as one edit.
    assert.throws(() => check('count(inserted(wallet)) == 0', REFUND), /did you mean `wallets`\?/);
  });

  it('lists what it does know when nothing is close', () => {
    assert.throws(
      () => check('count(inserted(kubernetes_pods)) == 0', REFUND),
      /tables: ledger_entries, payments, wallets/,
    );
  });

  it('still accepts every table that is really there', () => {
    // The fix must not make a legitimate assertion unevaluable.
    assert.ok(check('count(inserted(ledger_entries)) == 2', REFUND).passed);
    assert.ok(check('count(updated(wallets)) == 2', REFUND).passed);
  });

  it('refuses a table outside the watch scope', () => {
    const scoped: ChangeSet = {
      ...REFUND,
      scope: {
        schema: 'public',
        database: 'test',
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

describe('predicates with more than one clause', () => {
  // The composite-key form anyone would write. Before commas were a separator,
  // the whole tail parsed as one clause looking for the literal `acc_alice",
  // ref = "h1` — it matched nothing, said nothing, and left `count(...) == 0`
  // satisfied over a row that was really there.
  const holds = changeSet([
    {
      table: 'holds',
      key: null,
      kind: 'insert',
      before: null,
      after: {
        account_id: visible('text', 'acc_alice'),
        ref: visible('text', 'h1'),
        note: visible('text', 'split, then settle'),
      },
      changedColumns: ['account_id', 'ref', 'note'],
      visibleColumns: ['account_id', 'ref', 'note'],
      hasWrite: true,
    },
  ]);

  it('treats a comma as and', () => {
    assert.equal(check('count(inserted(holds, account_id = "acc_alice", ref = "h1")) == 1', holds).passed, true);
    assert.equal(check('count(inserted(holds, account_id = "acc_alice", ref = "nope")) == 0', holds).passed, true);
  });

  it('still accepts the word and', () => {
    assert.equal(check('count(inserted(holds, account_id = "acc_alice" and ref = "h1")) == 1', holds).passed, true);
  });

  it('does not split on a comma inside a value', () => {
    assert.equal(check('count(inserted(holds, note = "split, then settle")) == 1', holds).passed, true);
  });

  it('refuses a value that is quoted but not closed, rather than not matching', () => {
    // The dangerous direction: a malformed predicate that quietly selects
    // nothing is indistinguishable from a correct one that found nothing.
    assert.throws(() => check('count(inserted(holds, ref = "h1)) == 0', holds), /not closed|unterminated/);
  });
});

describe('atomic and writeCount', () => {
  const refuses = (source: string, changes: ChangeSet, pattern: RegExp) =>
    assert.throws(() => check(source, changes), (e: unknown) => {
      assert.ok(e instanceof Unevaluable, `expected Unevaluable, got ${String(e)}`);
      assert.match(e.message, pattern);
      return true;
    });

  const row = (table: string, id: string): RowChange => ({
    table,
    key: { columns: [{ column: 'id', value: visible('text', id) }], token: `[["id","${id}"]]` },
    kind: 'update',
    before: null,
    after: null,
    changedColumns: [],
    visibleColumns: [],
    hasWrite: true,
  });

  const transactional = (
    changes: RowChange[],
    mutations: Array<{ table: string; id: string | null; txn: string | null; op?: 'insert' | 'update' | 'delete' }>,
  ): ChangeSet => ({
    ...changeSet(changes),
    captureMethod: 'wal',
    fidelity: 'transactional',
    mutations: mutations.map((m, i) => ({
      sequence: i,
      transactionId: m.txn,
      table: m.table,
      operation: m.op ?? 'update',
      key:
        m.id === null
          ? null
          : {
              columns: [{ column: 'id', value: visible('text', m.id) }],
              token: `[["id","${m.id}"]]`,
            },
    })),
  });

  it('is true when one transaction did everything', () => {
    const seen = transactional(
      [row('payments', 'p1'), row('wallets', 'w1')],
      [
        { table: 'payments', id: 'p1', txn: '900' },
        { table: 'wallets', id: 'w1', txn: '900' },
      ],
    );
    assert.equal(check('atomic(changes(*)) == true', seen).passed, true);
  });

  it('is false when the same rows came from two transactions', () => {
    // The bug this exists to catch: the ledger entry landed, then a separate
    // transaction moved the balance, so a crash between them splits them.
    const seen = transactional(
      [row('payments', 'p1'), row('wallets', 'w1')],
      [
        { table: 'payments', id: 'p1', txn: '900' },
        { table: 'wallets', id: 'w1', txn: '901' },
      ],
    );
    const result = check('atomic(changes(*)) == true', seen);
    assert.equal(result.passed, false);
    assert.equal(result.actual, 'false');
  });

  it('counts writes, not changed rows', () => {
    // One row ended up where it started, and was written twice getting there.
    const seen = transactional(
      [row('wallets', 'w1')],
      [
        { table: 'wallets', id: 'w1', txn: '900' },
        { table: 'wallets', id: 'w1', txn: '900' },
      ],
    );
    assert.equal(check('count(updated(wallets)) == 1', seen).passed, true);
    assert.equal(check('writeCount(changes(wallets)) == 2', seen).passed, true);
  });

  it('refuses both against an engine that only knows the net view', () => {
    // Not false — unanswerable. mvcc-xmin saw the row change and has no idea
    // whether one transaction or three did it.
    const net = changeSet([row('payments', 'p1')]);
    refuses('atomic(changes(*)) == true', net, /needs the order writes happened in/);
    refuses('writeCount(changes(*)) == 1', net, /needs the order writes happened in/);
  });

  it('refuses atomic() over rows nothing wrote', () => {
    // Vacuously true is the answer that makes an atomicity check pass over a
    // step that did nothing at all.
    const seen = transactional([], []);
    refuses('atomic(changes(*)) == true', seen, /no grouping to check/);
  });

  it('refuses atomic() when a write has no transaction id', () => {
    const seen = transactional([row('payments', 'p1')], [{ table: 'payments', id: 'p1', txn: null }]);
    refuses('atomic(changes(*)) == true', seen, /without one/);
  });

  it('narrows to the rows the selector picked', () => {
    const seen = transactional(
      [row('payments', 'p1'), row('wallets', 'w1')],
      [
        { table: 'payments', id: 'p1', txn: '900' },
        { table: 'wallets', id: 'w1', txn: '901' },
      ],
    );
    // Each on its own is atomic; together they are not.
    assert.equal(check('atomic(changes(payments)) == true', seen).passed, true);
    assert.equal(check('atomic(changes(*)) == false', seen).passed, true);
  });
});

describe('rows() reads the rows, not the changes', () => {
  /** A step that wrote a payment and left `wal_alice` alone. */
  const wroteElsewhere = changeSet([
    {
      table: 'payments',
      key: null,
      kind: 'insert',
      before: null,
      after: { id: visible('text', 'pay_1') },
      changedColumns: ['id'],
      visibleColumns: ['id'],
      hasWrite: true,
    },
  ]);

  /** `wal_alice` exists in the database; this step did not touch it. */
  const alice: RowChange = {
    table: 'wallets',
    key: {
      columns: [{ column: 'id', value: visible('text', 'wal_alice') }],
      token: '[["id","wal_alice"]]',
    },
    kind: 'unchanged',
    before: { id: visible('text', 'wal_alice'), balance: visible('numeric', '1000.00') },
    after: { id: visible('text', 'wal_alice'), balance: visible('numeric', '1000.00') },
    changedColumns: [],
    visibleColumns: [],
    hasWrite: false,
  };

  const withWallets = { ...wroteElsewhere, scope: { schema: 'public', database: 'test', allTables: true, tables: [
    ...wroteElsewhere.scope.tables,
    { table: 'wallets', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' as const },
  ] } };

  const withLookup = (source: string) =>
    evaluateAssertion(parse(source), {
      changes: withWallets,
      variables: {},
      lookupRows: () => ({ rows: [alice], complete: true }),
    });

  it('finds a row that exists and was not written', () => {
    // The forbidden green this closed: `rows` answered from the change set, so
    // it was a synonym for `changes`, and this counted zero over a wallet that
    // is plainly there — the same shape as an assertion about a misspelled
    // table finding nothing and calling that proof.
    assert.equal(withLookup('count(rows(wallets, id = "wal_alice")) == 1').passed, true);
    assert.equal(withLookup('count(rows(wallets, id = "wal_alice")) == 0').passed, false);
    assert.equal(withLookup('after(single(rows(wallets, id = "wal_alice")).balance) == "1000.00"').passed, true);
  });

  it('reports no change for a row nothing wrote', () => {
    // Both images are the current row, so a delta over it is zero — which is
    // what happened, rather than an absence that would mean something else.
    assert.equal(withLookup('delta(single(rows(wallets, id = "wal_alice")).balance) == "0.00"').passed, true);
    assert.equal(withLookup('hasWrite(rows(wallets)) == false').passed, true);
  });

  it('refuses rather than answering from the change set when it cannot read', () => {
    // Not `false`, and not a count of what happened to change. Without a way
    // to read the rows, the question has no answer.
    assert.throws(
      () => evaluateAssertion(parse('count(rows(wallets)) == 0'), { changes: withWallets, variables: {} }),
      (e: unknown) => {
        assert.ok(e instanceof Unevaluable);
        assert.match(e.message, /reads the rows as they are now/);
        assert.match(e.message, /`changes\(wallets\)`/);
        return true;
      },
    );
  });

  it('keeps the real before-image for a row that did change', () => {
    // The union is what makes this work: a row already in the change set keeps
    // what it looked like before, and only the untouched ones come from now.
    assert.ok(check('delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"', REFUND).passed);
  });
});

const EVENTS = {
  table: 'events',
  ignoreColumns: [],
  maskedColumns: [],
  keyStrategy: 'primary-key',
} as const;

describe('a read that stopped at its limit', () => {
  // Selectors are bounded — one that matches a whole table is a mistake worth
  // surfacing rather than a query worth running — and the bound used to be
  // applied silently. Measured on a 1200-row table: `rows(events)` returned
  // 500 and `count(rows(events))` answered 500. A lower bound, presented as a
  // total.
  const rows = Array.from({ length: 3 }, (_, i) => ({
    table: 'events',
    key: { columns: [{ column: 'id', value: visible('int4', String(i)) }], token: `t${i}` },
    kind: 'unchanged' as const,
    before: { id: visible('int4', String(i)) },
    after: { id: visible('int4', String(i)) },
    changedColumns: [],
    visibleColumns: [],
    hasWrite: false,
  }));

  const ask = (
    source: string,
    complete: boolean,
    set: readonly RowChange[] = rows,
  ): 'answered' | string => {
    try {
      evaluateAssertion(parse(source), {
        // `events` in scope but nothing changed: `rows(...)` unions the change
        // set with the lookup, and seeding both would make every count off by
        // the number of changes.
        changes: { ...changeSet([]), scope: { ...changeSet([]).scope, tables: [EVENTS] } },
        variables: {},
        lookupRows: () => ({ rows: set, complete }),
      });
      return 'answered';
    } catch (error) {
      return error instanceof Unevaluable ? error.message : `threw ${String(error)}`;
    }
  };

  for (const source of [
    'count(rows(events)) == 3',
    'isEmpty(rows(events))',
    'any(rows(events))',
  ]) {
    it(`refuses \`${source}\` over a partial read`, () => {
      assert.equal(ask(source, true), 'answered', 'it must answer when the read was complete');
      assert.match(ask(source, false), /needs the whole set/);
    });
  }

  it('refuses single() over a partial read, because a second match may be unread', () => {
    // With one row and a complete read, `single()` is exactly the right
    // question and answers. With one row and a *partial* read it cannot: the
    // rows nobody looked at might hold a second match.
    const one = rows.slice(0, 1);
    assert.equal(ask('single(rows(events)).after.id == "0"', true, one), 'answered');
    assert.match(ask('single(rows(events)).after.id == "0"', false, one), /needs the whole set/);
  });

  it('stays refused after a predicate narrows it', () => {
    // Narrowing does not complete it: the rows that were never read might have
    // matched too, so the count is still a lower bound.
    assert.match(ask('count(rows(events).where(id = "0")) == 1', false), /needs the whole set/);
  });
});

describe('predicateColumnsIn', () => {
  /**
   * The names `check` has to resolve before a run, because the evaluator only
   * resolves them when there is a row to resolve them against — and the case
   * that matters most is the one where there is not.
   */
  const at = (source: string): string[] =>
    predicateColumnsIn(parse(source))
      .map((p) => `${p.table}.${p.column}`)
      .sort();

  it('finds the column in a `.where()`', () => {
    assert.deepEqual(at('count(inserted(widgets).where(nmae = "x")) == 0'), ['widgets.nmae']);
  });

  it("finds the column in `rows()`'s second argument", () => {
    assert.deepEqual(at('count(rows(widgets, sku = "A")) == 1'), ['widgets.sku']);
  });

  it('finds both halves of a composite key', () => {
    // The comma-splitting this shares with `matchesPredicate` is the reason
    // that function has the comment it has.
    assert.deepEqual(at('count(rows(holds, account_id = "a", ref = "h")) == 1'), [
      'holds.account_id',
      'holds.ref',
    ]);
  });

  it('walks both sides of a logical operator', () => {
    assert.deepEqual(
      at('count(inserted(a).where(x = "1")) == 0 and count(inserted(b).where(y = "2")) == 0'),
      ['a.x', 'b.y'],
    );
  });

  it('walks through a negation', () => {
    assert.deepEqual(at('not (count(inserted(t).where(c = "1")) == 0)'), ['t.c']);
  });

  it('carries the table down through a column selection', () => {
    assert.deepEqual(at('single(updated(wallets).where(id = "w")).after.balance == "1"'), [
      'wallets.id',
    ]);
  });

  it('skips a predicate with no one table to resolve it against', () => {
    // `changes(*)` is every table in scope; a column named there could belong
    // to any of them, and guessing is worse than saying nothing.
    assert.deepEqual(at('hasWrite(changes(*)) == false'), []);
  });

  it('finds nothing where there is no predicate', () => {
    assert.deepEqual(at('count(inserted(widgets)) == 0'), []);
  });
});

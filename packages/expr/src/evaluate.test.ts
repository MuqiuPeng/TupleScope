import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, Detection, Row, RowChange, Value, VisibleValue } from '@tuplescope/core';
import { ExprSyntaxError, parse } from './parse.js';
import {
  Unevaluable,
  evaluateAssertion,
  predicateClauses,
  predicateColumnsIn,
  valuesEqual,
  tablesNamedIn,
} from './evaluate.js';
import { masked, textIfVisible, visible } from '@tuplescope/core';

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

// ─── columns whose side comes from outside them ───────────────────────────────

describe('a column whose side is supplied from outside it', () => {
  // `parse` now refuses a column with no side at load, because the evaluator
  // refuses every one it reaches. These are the forms where a wrapper or a
  // postfix supplies the side: each must still parse *and* be decided, or the
  // parser's rule and the evaluator's disagree and a working file stops loading.
  for (const source of [
    'delta(single(updated(wallets, id = "wal_alice")).balance) == "100.00"',
    'sum(delta(wallets.balance)) == "0.00"',
    'after(single(updated(wallets, id = "wal_alice")).balance) == "1000.00"',
    'before(single(updated(wallets, id = "wal_alice")).balance) == "900.00"',
    'after(updated(wallets, id = "wal_alice").balance) == "1000.00"',
    'max(after(updated(wallets).balance)) == "1000.00"',
    'sum(after(inserted(ledger_entries).amount)) == "0.00"',
    'delta(single(rows(wallets, id = "wal_alice")).balance) == "100.00"',
    'single(updated(payments)).before.status == "COMPLETED"',
    'single(updated(payments)).after.status == "REFUNDED"',
    'single(updated(wallets, id = "wal_shop")).delta.balance == "-100.00"',
    'sum(wallets.after.balance) == "1000.00"',
  ]) {
    it(`decides \`${source}\``, () => {
      assert.equal(check(source, REFUND).passed, true);
    });
  }
});

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

  it('reads a boolean by its value, not its spelling', () => {
    // PostgreSQL sends `t`; a scenario writes `true`. Found on the first real
    // install: `after.isActive == true` failed against every active row with
    // "expected true, got t" — and `!= true` would have passed against every
    // one, which is the worse half.
    assert.ok(valuesEqual(v('t', 'bool'), v('true', 'bool')));
    assert.ok(valuesEqual(v('f', 'bool'), v('false', 'bool')));
    assert.equal(valuesEqual(v('t', 'bool'), v('false', 'bool')), false);
    // The wire form written as a string still names the same value.
    assert.ok(valuesEqual(v('t', 'bool'), v('t', 'text')));
    // A value that is not a spelling of either is not quietly one of them.
    assert.equal(valuesEqual(v('t', 'bool'), v('yes', 'bool')), false);
  });

  it('lets an assertion say == true about a bool column', () => {
    const active = changeSet([
      change({
        table: 'wallets',
        kind: 'insert',
        after: row({ id: v('wal_split'), isActive: v('t', 'bool') }),
      }),
    ]);
    assert.equal(check('single(inserted(wallets)).after.isActive == true', active).passed, true);
    assert.equal(check('single(inserted(wallets)).after.isActive != true', active).passed, false);
    assert.equal(check('count(inserted(wallets).where(isActive = true)) == 1', active).passed, true);
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
    // At load now, not here. Every such column the evaluator reached was
    // refused, so `parse` refuses the form (parse.test, `a column with no
    // side`); the evaluator keeps its refusal, in the same sentence, for an
    // `Expr` built without `parse`.
    assert.throws(
      () => check('single(updated(payments)).status == "REFUNDED"', REFUND),
      (error: unknown) => error instanceof ExprSyntaxError && /needs a side/.test(error.message),
    );
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

  /**
   * The half the guard was missing.
   *
   * `count()` and `isEmpty()` are questions about the *set*, and the guard
   * caught those because it inspects a selection. `sum()` is a question about
   * the set too — it just reads a column on the way — and reading that column
   * discarded the truncation flag, so the guard was called with a value that
   * could not carry it and silently passed. Measured: `count(rows(events))`
   * refused while `sum(after(rows(events).id))` answered 3 over a read that
   * stopped early. A fraction, presented as a total.
   */
  for (const source of [
    'sum(after(rows(events).id)) == "3"',
    'min(after(rows(events).id)) == "0"',
    'max(after(rows(events).id)) == "2"',
    'sum(delta(rows(events).id)) == "0"',
  ]) {
    it(`refuses \`${source}\` over a partial read`, () => {
      assert.equal(ask(source, true), 'answered', 'it must answer when the read was complete');
      assert.match(ask(source, false), /needs the whole set/);
    });
  }

  it('refuses hasWrite() over a partial read, because an unread row may hold the write', () => {
    // `hasWrite(...) == false` is the shape of a "this endpoint wrote nothing
    // here" guard. Over a truncated read, false means "none of the rows I
    // happened to read had a write", which is a different claim.
    assert.equal(ask('hasWrite(rows(events)) == false', true), 'answered');
    assert.match(ask('hasWrite(rows(events)) == false', false), /needs the whole set/);
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

describe('a predicate that cannot be answered', () => {
  /**
   * All three of these used to be green, and two of them were green over data
   * that contradicted them one line above in the same report. The refusal has
   * to happen where a row count cannot reach it — `Array.prototype.filter`
   * never calls its callback on an empty list, so a predicate over a selection
   * that matched nothing was never read at all, and `count(...) == 0` was
   * satisfied by never having done any work.
   */
  it('refuses an operator it cannot evaluate, rather than never reading it', () => {
    assert.throws(() => parse('count(inserted(t).where(amount > 100)) == 0'), /`>` is not available/);
    assert.throws(() => parse('count(rows(t, n <= 3)) == 0'), /not available/);
    assert.throws(() => parse('count(inserted(t).where(name like "a%")) == 0'), /not available/);
  });

  it('refuses `or` rather than folding it into one mangled literal', () => {
    // Measured before this: `kind = "A" or kind = "B"` survived as a single
    // clause whose expected value was the fifteen characters `A" or kind = "B`.
    // It matched nothing, and written as `== 0` it passed with both rows
    // rendered directly above it.
    assert.throws(
      () => parse('count(inserted(t).where(kind = "A" or kind = "B")) == 0'),
      /`or` is not available/,
    );
  });

  it('leaves an `or` inside a quoted value alone', () => {
    const clauses = predicateClauses('name = "Bob or Alice"');
    assert.deepEqual(clauses, [{ column: 'name', value: 'Bob or Alice' }]);
  });

  it('reads a bare `null` as SQL NULL, not as four characters', () => {
    assert.deepEqual(predicateClauses('note = null'), [{ column: 'note', value: null }]);
    assert.deepEqual(predicateClauses('note = NULL'), [{ column: 'note', value: null }]);
    // Quoted, it is the word.
    assert.deepEqual(predicateClauses('note = "null"'), [{ column: 'note', value: 'null' }]);
  });

  it('refuses at parse time, so an empty selection cannot skip the check', () => {
    // The point of moving this out of the per-row match: `check` and the
    // scenario loader both see it, before any row exists to be filtered.
    assert.throws(() => parse('count(inserted(t).where(x > 1)) == 0'), ExprSyntaxError);
  });

  it('still splits on `and` and on a comma', () => {
    assert.deepEqual(predicateClauses('a = "x" and b = "y"'), [
      { column: 'a', value: 'x' },
      { column: 'b', value: 'y' },
    ]);
    assert.deepEqual(predicateClauses('a = "x", b = "y"'), [
      { column: 'a', value: 'x' },
      { column: 'b', value: 'y' },
    ]);
  });
});

describe('changes(* except …)', () => {
  /**
   * The containment question — "nothing outside these tables changed" — had no
   * spelling. What people wrote instead was one `isEmpty` per remaining table,
   * and that fails open: add a table and the assertion keeps passing while the
   * new table changes freely. Every other hole in this language errs the other
   * way.
   */
  const twoTables = changeSet([
    change({ table: 'payments', kind: 'insert', after: row({ id: v('p1') }) }),
    change({ table: 'audit_log', kind: 'insert', after: row({ id: v('a1') }) }),
  ]);

  it('leaves out the tables it names', () => {
    assert.ok(check('count(changes(* except audit_log)) == 1', twoTables).passed);
    assert.ok(check('count(changes(*)) == 2', twoTables).passed);
  });

  it('catches a table the author did not carve out', () => {
    // The whole point: it has to notice a write nobody told it to expect.
    // `payments` alone leaves `audit_log` inside the complement.
    assert.equal(check('hasWrite(changes(* except payments)) == false', twoTables).passed, false);
    assert.ok(check('hasWrite(changes(* except payments, audit_log)) == false', twoTables).passed);
  });

  it('refuses an exclusion that names nothing, rather than widening', () => {
    // An `except` resolving to no table excludes no rows, so the assertion
    // silently covers a table the author believed they had removed — the
    // failure this form exists to prevent, arriving through the form itself.
    assert.throws(
      () => check('hasWrite(changes(* except nosuch)) == false', twoTables),
      /excludes nothing/,
    );
  });

  it('needs `*` on its left', () => {
    assert.throws(() => parse('count(changes(payments except audit_log)) == 0'), /needs `\*`/);
  });

  it('wants a table name after it', () => {
    assert.throws(() => parse('count(changes(* except)) == 0'), /expected a table name/);
  });
});

/**
 * A table with no key, and the questions that are empty there whatever happened.
 *
 * The MVCC engines skip the key read for a table with no primary key and no
 * unique index, so a DELETE from it leaves no trace anywhere in `changes` and an
 * UPDATE arrives as an insert. `count(deleted(t)) == 0` and
 * `isEmpty(updated(t))` therefore pass over any amount of real activity — not
 * imprecisely, but structurally, every time.
 *
 * `keyStrategy` alone cannot express this: all three engines report
 * `full-row-multiset` for such a table and then behave differently, because
 * snapshot-diff re-reads and sees the multiset deficit. Hence a separate axis,
 * declared by the engine rather than inferred from the schema.
 */
describe('a table whose departures cannot be observed', () => {
  const base = changeSet([]);
  const scopeWith = (departuresObservable: boolean): ChangeSet => ({
    ...base,
    // Write detection either way: this is about row identity, not about the
    // detection axis, and sharing a captureMethod with the axis would make the
    // test pass for the wrong reason.
    captureMethod: departuresObservable ? 'snapshot-diff' : 'mvcc-xmin',
    scope: {
      ...base.scope,
      allTables: true,
      tables: [
        { table: 'wallets', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
        {
          table: 'audit_log',
          ignoreColumns: [],
          maskedColumns: [],
          keyStrategy: 'full-row-multiset',
          departuresObservable,
        },
      ],
    },
  });

  const ask = (source: string, departuresObservable = false): 'answered' | string => {
    try {
      evaluateAssertion(parse(source), {
        changes: scopeWith(departuresObservable),
        variables: {},
      });
      return 'answered';
    } catch (error) {
      return error instanceof Unevaluable ? error.message : `threw ${String(error)}`;
    }
  };

  for (const source of [
    'count(deleted(audit_log)) == 0',
    'isEmpty(deleted(audit_log))',
    'isEmpty(updated(audit_log))',
    'any(updated(audit_log))',
  ]) {
    it(`refuses \`${source}\`, which is empty however much happened`, () => {
      assert.match(ask(source), /no primary key or unique index/);
      // The same question is answerable on an engine that re-reads the table.
      assert.equal(ask(source, true), 'answered', 'snapshot-diff can see a departure');
    });
  }


  it('still answers about a keyed table in the same scope', () => {
    // The refusal is about the table that cannot be read, not about the run.
    assert.equal(ask('count(deleted(wallets)) == 0'), 'answered');
  });

  it('still answers about inserts into the keyless table, which are reported', () => {
    // A change there arrives as an insert. That is a real observation and is not
    // what this guard is about — over-refusing would cost the one question the
    // engine can still answer.
    assert.equal(ask('count(inserted(audit_log)) == 0'), 'answered');
  });

  it('answers a whole-scope claim once the blind table is excluded', () => {
    assert.equal(ask('hasWrite(changes(* except audit_log)) == false'), 'answered');
  });
});

// ─── names, masks and escapes that used to be answered ────────────────────────

/** A wallet that moved 10.00 → 90.00. `secret` is present, as a masked column is. */
const MOVED = change({
  table: 'wallets',
  kind: 'update',
  before: row({ id: v('w1'), balance: money('10.00'), secret: masked('text') }),
  after: row({ id: v('w1'), balance: money('90.00'), secret: masked('text') }),
});

/** A scope in which `wallets.secret` is masked and `ledger_entries` masks nothing. */
function maskedScope(changes: readonly RowChange[]): ChangeSet {
  const base = changeSet(changes);
  return {
    ...base,
    scope: {
      ...base.scope,
      tables: [
        { table: 'wallets', ignoreColumns: [], maskedColumns: ['secret'], keyStrategy: 'primary-key' },
        { table: 'ledger_entries', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
      ],
    },
  };
}

describe('a column the row does not have', () => {
  // Every captured row carries every column, so a name missing from a row that
  // exists is a misspelling. Read as absent, it was an answer.
  const moved = maskedScope([MOVED]);
  const typo = (e: unknown): boolean =>
    e instanceof Unevaluable &&
    e.message === 'there is no column `balanse` in `wallets` — did you mean `balance`?';

  it('refuses a misspelled column under delta, rather than reading it as zero', () => {
    // Measured before: {"passed":true} over a wallet that moved by 80.00.
    assert.throws(() => check('sum(delta(wallets.balanse)) == "0"', moved), typo);
    // Spelled right, the same assertion fails, with the movement.
    assert.deepEqual(check('sum(delta(wallets.balance)) == "0"', moved), {
      passed: false,
      actual: '80.00',
      expected: '0',
    });
  });

  for (const source of [
    'delta(single(updated(wallets)).balanse) == "0"',
    'single(updated(wallets)).delta.balanse == "0"',
    // Both were green before: the missing value came back as NULL.
    'single(updated(wallets)).after.balanse == null',
    'single(updated(wallets)).after.balanse != "90.00"',
    'single(updated(wallets)).before.balanse == null',
    'sum(wallets.after.balanse) == "90.00"',
    'min(before(updated(wallets).balanse)) == "10.00"',
    'max(after(updated(wallets).balanse)) == "90.00"',
    'after(single(rows(wallets, id = "w1")).balanse) == "90.00"',
    'sum(changes(*).delta.balanse) == "0"',
  ]) {
    it(`refuses \`${source}\`, naming the column and the table`, () => {
      assert.throws(() => check(source, moved), typo);
    });
  }

  it('asks the image that exists, whichever side is read', () => {
    // An insert has no before image; its after image still says the table has
    // no `balanse`. Before, the before side read as NULL and this passed.
    const inserted = maskedScope([
      change({ table: 'wallets', kind: 'insert', after: row({ id: v('w2'), balance: money('5.00') }) }),
    ]);
    assert.throws(() => check('single(inserted(wallets)).before.balanse == null', inserted), typo);
    // A real column on the side that does not exist is still NULL: this is
    // about names, not sides.
    assert.equal(check('single(inserted(wallets)).before.balance == null', inserted).passed, true);
    assert.equal(check('sum(delta(wallets.balance)) == "5.00"', inserted).passed, true);
  });

  it('lists the columns there are when none is close', () => {
    assert.throws(
      () => check('single(updated(wallets)).after.zzz == null', moved),
      /^Unevaluable: there is no column `zzz` in `wallets` \(columns: id, balance, secret\)$/,
    );
  });

  it('reads a masked column as masked, not as missing', () => {
    assert.throws(
      () => check('single(updated(wallets)).after.secret == "x"', moved),
      (e: unknown) => e instanceof Unevaluable && /is masked at capture/.test(e.message),
    );
  });

  it('answers over an empty selection, where there is no row to ask', () => {
    // Nothing was written, so the sum really is zero. A run cannot tell a
    // misspelling from here; `check` resolves a named table's column first.
    assert.equal(check('sum(delta(wallets.balanse)) == "0"', maskedScope([])).passed, true);
  });
});

describe('a masked column, refused from the scope', () => {
  // With a row these were refused; without one they passed. An assertion that
  // can pass and cannot fail is the thing this tool exists to refuse.
  const nothing = maskedScope([]);
  const refusal = (e: unknown): boolean =>
    e instanceof Unevaluable &&
    e.message ===
      '`wallets.secret` is masked at capture, so this run does not have its value. ' +
        'Remove the column from `maskColumns` if the assertion needs it.';

  it('refuses a .where on it over an empty selection', () => {
    // Measured before: {"passed":true}, `secret` masked and nothing inserted.
    assert.throws(() => check('count(inserted(wallets).where(secret = "x")) == 0', nothing), refusal);
  });

  it('refuses it in a selector predicate', () => {
    assert.throws(() => check('count(inserted(wallets, secret = "x")) == 0', nothing), refusal);
    assert.throws(() => check('isEmpty(updated(wallets, secret = "x")) == true', nothing), refusal);
  });

  it('refuses it in rows(...) before any row is read', () => {
    let read = false;
    assert.throws(
      () =>
        evaluateAssertion(parse('count(rows(wallets, secret = "x")) == 0'), {
          changes: nothing,
          variables: {},
          lookupRows: () => {
            read = true;
            return { rows: [], complete: true };
          },
        }),
      refusal,
    );
    assert.equal(read, false);
  });

  it('refuses it under changes(*) when any table the selection spans masks it', () => {
    assert.throws(() => check('count(changes(*).where(secret = "x")) == 0', nothing), refusal);
    assert.throws(() => check('count(changes(*, secret = "x")) == 0', nothing), refusal);
    // With the one table that masks it carved out, nothing left masks it.
    assert.equal(check('count(changes(* except wallets).where(secret = "x")) == 0', nothing).passed, true);
  });

  it('refuses a sum of it, the one value read that answers over no rows', () => {
    // Measured before: {"passed":true} — a sum of nothing is 0.
    assert.throws(() => check('sum(inserted(wallets).after.secret) == "0"', nothing), refusal);
    assert.throws(() => check('sum(delta(wallets.secret)) == "0"', nothing), refusal);
    // With a row, the refusal names the column rather than `value 0`. (Under
    // delta the column read itself refuses first, per value.)
    assert.throws(() => check('sum(updated(wallets).after.secret) == "0"', maskedScope([MOVED])), refusal);
  });

  it('still answers a visible column over an empty selection', () => {
    assert.equal(check('count(inserted(wallets).where(id = "x")) == 0', nothing).passed, true);
    assert.equal(check('sum(inserted(wallets).after.balance) == "0"', nothing).passed, true);
  });
});

describe("a predicate's quoted value", () => {
  // One quoted text, one value, wherever it is written.

  it('reads a backslash the way the comparison beside it does', () => {
    // Source text `"a\\b"`. Measured before: three characters as a comparison
    // literal, four as a predicate value.
    const cmp = parse('x == "a\\\\b"');
    assert.ok(cmp.node === 'compare' && cmp.right.node === 'literal');
    assert.equal(cmp.right.value, 'a\\b');
    assert.deepEqual(predicateClauses('id = "a\\\\b"'), [{ column: 'id', value: 'a\\b' }]);
  });

  it('takes an escaped quote as part of the value', () => {
    // Measured before: `unterminated " in predicate`.
    assert.deepEqual(predicateClauses('id = "a\\"b"'), [{ column: 'id', value: 'a"b' }]);
    assert.deepEqual(predicateClauses("id = 'it\\'s'"), [{ column: 'id', value: "it's" }]);
    assert.doesNotThrow(() => parse('count(rows(t, id = "a\\"b")) == 0'));
  });

  it('does not split a clause on a comma behind an escaped quote', () => {
    assert.deepEqual(predicateClauses('note = "a\\", b = \\"c"'), [{ column: 'note', value: 'a", b = "c' }]);
  });

  it('matches the row the text names', () => {
    const odd = changeSet([
      change({ table: 't', kind: 'insert', after: row({ id: v('a\\b') }) }),
      change({ table: 't', kind: 'insert', after: row({ id: v('q"r') }) }),
    ]);
    // Before, this looked for the four characters `a\\b`, matched nothing, and
    // `== 0` passed over the row that was there.
    assert.equal(check('count(inserted(t).where(id = "a\\\\b")) == 0', odd).passed, false);
    assert.equal(check('count(inserted(t).where(id = "a\\\\b")) == 1', odd).passed, true);
    assert.equal(check('count(inserted(t, id = "q\\"r")) == 1', odd).passed, true);
  });

  it('refuses a value that goes on after its closing quote', () => {
    // Read before as the one value `a" "b`.
    assert.throws(() => predicateClauses('id = "a" "b"'), /goes on after its closing quote/);
    assert.throws(() => parse('count(rows(t, id = "a" "b")) == 0'), ExprSyntaxError);
  });
});

describe('tablesNamedIn', () => {
  const named = (source: string): string[] => [...tablesNamedIn(parse(source))].sort();

  it('finds a table in a selector, as the old regex did', () => {
    assert.deepEqual(named('count(inserted(ledger_entries)) == 1'), ['ledger_entries']);
  });

  it('finds one behind the bare-table shorthand, which the regex could not', () => {
    // `sum(delta(wallets.balance))` carries no `changes(` for a regex to anchor
    // on — the shorthand becomes a `changes` selector during parsing. This is
    // the form `promote` generates, so the blind spot fell exactly on the
    // assertions nobody writes by hand.
    assert.deepEqual(named('sum(delta(wallets.balance)) == "0.00"'), ['wallets']);
  });

  it('finds every table in a comparison of two selectors', () => {
    assert.deepEqual(
      named('count(inserted(refunds)) == count(inserted(payments))'),
      ['payments', 'refunds'],
    );
  });

  it('finds one through a predicate and a column read', () => {
    assert.deepEqual(named('after(single(updated(stock, sku = "X")).on_hand) == "1"'), ['stock']);
  });

  it('names nothing for a whole-scope selector, which has no table to name', () => {
    assert.deepEqual(named('hasWrite(changes(*)) == false'), []);
  });
});

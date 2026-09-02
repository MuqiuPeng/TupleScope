/**
 * What every capture engine has to agree about.
 *
 * A case is a piece of SQL and a set of assertions to evaluate against whatever
 * the engine saw. The point is not to test the SQL — it is to pin down, in one
 * place, the answers that must not depend on how the writes were observed.
 *
 * Expectations come in two shapes, and the difference is the whole design:
 *
 *   `expect`         every engine must produce this
 *   `expectByDetection`  the answer legitimately differs, and the case says
 *                        which capability decides it
 *
 * There is deliberately no third shape keyed on the engine's name. If a new
 * engine needs one, the capability vocabulary is missing an axis and the fix is
 * to add it to ChangeSet — not to add a branch here, which would only move the
 * `if (engine === 'wal')` out of the consumers and into their test suite.
 */

import type { Detection, Fidelity } from '@tuplescope/core';

/**
 * A capability profile: the two axes together.
 *
 * Needed because some answers depend on both. A row inserted and deleted inside
 * one transaction is invisible to `write/net` (no row version survives),
 * unanswerable under `value/net` (a count over `changes`), and plainly visible
 * to `write/transactional`. No single axis says that.
 */
export type Capability = `${Detection}/${Fidelity}`;

/** How an assertion came out, flattened so two engines can be compared directly. */
export type Answer =
  | { status: 'passed' }
  | { status: 'failed'; actual: string }
  | { status: 'unevaluable'; reason?: string };

export const passed: Answer = { status: 'passed' };
export const unevaluable: Answer = { status: 'unevaluable' };
export const failed = (actual: string): Answer => ({ status: 'failed', actual });

export interface ConformanceCase {
  name: string;
  /** Why this case is here at all — printed when it fails. */
  because: string;
  /** Rows to put in place before the observation window opens. */
  seed?: string[];
  /** Columns the workspace redacts, applied to the scope this case runs under. */
  maskColumns?: string[];
  /** The writes the "request" performs, inside the window. */
  act: string[];
  /** Assertions every engine must answer identically. */
  expect: Record<string, Answer>;
  /**
   * What the ordered mutation list must contain, as `table:operation:key`.
   *
   * Only meaningful for a `transactional` engine; a `net` one must not offer
   * the list at all. Stating it here is what makes `fidelity` falsifiable —
   * without it an engine could declare `transactional`, deliver nothing, and
   * pass every other check in this suite.
   */
  mutationsWhenTransactional?: string[];

  /**
   * Assertions whose answer is decided by a declared capability.
   *
   * An assertion may appear in at most one of these three; a collision throws
   * rather than letting one table silently win.
   */
  expectByDetection?: Record<string, Partial<Record<Detection, Answer>>>;
  expectByFidelity?: Record<string, Partial<Record<Fidelity, Answer>>>;
  /** For answers that depend on both axes at once. */
  expectByCapability?: Record<string, Partial<Record<Capability, Answer>>>;
  /**
   * Row-level facts every engine must report identically, as a normalized
   * summary: `table:kind:key -> changed columns`. Omitted where detection
   * decides whether the row appears at all.
   */
  shape?: Record<string, string[]>;
  shapeByDetection?: Partial<Record<Detection, Record<string, string[]>>>;
  shapeByCapability?: Partial<Record<Capability, Record<string, string[]>>>;
  /**
   * Why this case's row shape may differ between engines, when it may.
   *
   * Only legitimate where the run comes out `undecided` on every engine that
   * saw less — an incomplete observation that says it is incomplete misleads
   * nobody, and pinning a shape there would only encode one engine's limits as
   * the specification.
   */
  shapeUnpinned?: string;
}

export const SCHEMA = [
  `CREATE TABLE accounts (
     id text PRIMARY KEY,
     balance numeric(14,2) NOT NULL,
     status text NOT NULL DEFAULT 'ACTIVE',
     meta jsonb NOT NULL DEFAULT '{}'::jsonb,
     -- Wide enough to hold a value no JS number can: 2^53 + 1 has sixteen
     -- integer digits, and rounding it to fifteen is the bug this catches.
     exact_value numeric(30,10) NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE entries (
     id text PRIMARY KEY,
     account_id text NOT NULL,
     amount numeric(14,2) NOT NULL,
     kind text NOT NULL
   )`,
  `CREATE TABLE holds (
     account_id text NOT NULL,
     ref text NOT NULL,
     amount numeric(14,2) NOT NULL,
     PRIMARY KEY (account_id, ref)
   )`,
  // No primary key and no unique index: the degraded-identity path.
  `CREATE TABLE audit_log (note text NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
  /*
   * Key columns whose text differs between what a SELECT returns and what a
   * WAL decoder prints. A `bool` reads `t` over the wire and decodes as `true`;
   * a `bit(8)` reads `10101010` and decodes as `B'10101010'`. An engine that
   * matched one against the other would find no row — and report a database
   * where nothing happened.
   */
  `CREATE TABLE flags (id int NOT NULL, active bool NOT NULL, note text, PRIMARY KEY (id, active))`,
  `CREATE TABLE masks (mask bit(8) PRIMARY KEY, note text)`,
  // A primary key that is also redacted. Identity is a fact about the row;
  // redaction is about what the reader may see. Conflating them made an UPDATE
  // report as an insert with no before-image and no warning.
  `CREATE TABLE people (email text PRIMARY KEY, plan text)`,
];

const SEED = [
  `INSERT INTO accounts (id, balance) VALUES ('acc_alice', '1000.00'), ('acc_shop', '0.00')`,
  `INSERT INTO entries (id, account_id, amount, kind) VALUES ('ent_seed', 'acc_alice', '1000.00', 'TOPUP')`,
];

export const CASES: ConformanceCase[] = [
  {
    name: 'an insert',
    because: 'the simplest fact there is; if engines disagree here nothing else matters',
    seed: SEED,
    act: [`INSERT INTO entries (id, account_id, amount, kind) VALUES ('ent_1', 'acc_alice', '-40.00', 'DEBIT')`],
    expect: {
      'count(inserted(entries)) == 1': passed,
      'count(inserted(accounts)) == 0': passed,
      'after(single(rows(entries, id = "ent_1")).kind) == "DEBIT"': passed,
      'after(single(rows(entries, id = "ent_1")).amount) == "-40.00"': passed,
      'count(inserted(entries).where(kind = "CREDIT")) == 0': passed,
    },
    shape: { 'entries:insert:ent_1': ['id', 'account_id', 'amount', 'kind'] },
  },
  {
    name: 'an update that moves one column',
    because: 'changedColumns must name the column that moved and nothing else',
    seed: SEED,
    act: [`UPDATE accounts SET balance = '960.00' WHERE id = 'acc_alice'`],
    expect: {
      'before(single(rows(accounts, id = "acc_alice")).balance) == "1000.00"': passed,
      'after(single(rows(accounts, id = "acc_alice")).balance) == "960.00"': passed,
      'delta(single(updated(accounts)).balance) == "-40.00"': passed,
      'count(inserted(accounts)) == 0': passed,
      'count(deleted(accounts)) == 0': passed,
    },
    expectByDetection: {
      // Exact under write detection; a floor under value detection, because a
      // second account rewritten to its own balance would not be counted.
      'count(updated(accounts)) == 1': { write: passed, value: unevaluable },
    },
    // `updated_at` does not move: the UPDATE does not touch it and there is no
    // trigger, so both engines see exactly one column change.
    shape: { 'accounts:update:acc_alice': ['balance'] },
  },
  {
    name: 'a delete',
    because: 'the before-image has to survive the row',
    seed: SEED,
    act: [`DELETE FROM entries WHERE id = 'ent_seed'`],
    expect: {
      'count(deleted(entries)) == 1': passed,
      'before(single(rows(entries, id = "ent_seed")).kind) == "TOPUP"': passed,
      'count(inserted(entries)) == 0': passed,
    },
    shape: { 'entries:delete:ent_seed': ['id', 'account_id', 'amount', 'kind'] },
  },
  {
    name: 'a transfer across three tables',
    because: 'the realistic case, and the one where a sum over both sides must balance',
    seed: SEED,
    act: [
      `UPDATE accounts SET balance = balance - '40.00' WHERE id = 'acc_alice'`,
      `UPDATE accounts SET balance = balance + '40.00' WHERE id = 'acc_shop'`,
      `INSERT INTO entries (id, account_id, amount, kind) VALUES
         ('ent_d', 'acc_alice', '-40.00', 'DEBIT'), ('ent_c', 'acc_shop', '40.00', 'CREDIT')`,
      `INSERT INTO holds (account_id, ref, amount) VALUES ('acc_alice', 'hold_1', '40.00')`,
    ],
    expect: {
      'count(inserted(entries)) == 2': passed,
      'sum(delta(accounts.balance)) == "0.00"': passed,
      // Only rows that changed are in the set, so this sums the two new entries,
      // not the seeded one. The transfer nets to nothing, which is the point.
      'sum(after(entries.amount)) == "0.00"': passed,
      'delta(single(rows(accounts, id = "acc_alice")).balance) == "-40.00"': passed,
      'count(inserted(holds)) == 1': passed,
      'after(single(rows(holds, account_id = "acc_alice", ref = "hold_1")).amount) == "40.00"': passed,
    },
    expectByDetection: {
      'count(updated(accounts)) == 2': { write: passed, value: unevaluable },
    },
    // The order mvcc-xmin cannot know: which table the transfer touched first.
    mutationsWhenTransactional: [
      'accounts:update:acc_alice',
      'accounts:update:acc_shop',
      'entries:insert:ent_d',
      'entries:insert:ent_c',
      'holds:insert:acc_alice|hold_1',
    ],
    shape: {
      'accounts:update:acc_alice': ['balance'],
      'accounts:update:acc_shop': ['balance'],
      'entries:insert:ent_c': ['id', 'account_id', 'amount', 'kind'],
      'entries:insert:ent_d': ['id', 'account_id', 'amount', 'kind'],
      'holds:insert:acc_alice|hold_1': ['account_id', 'ref', 'amount'],
    },
  },
  {
    name: 'nothing at all',
    because: 'a quiet window must read as quiet, not as unobserved',
    seed: SEED,
    act: [],
    mutationsWhenTransactional: [],
    expect: {
      'count(inserted(entries)) == 0': passed,
      'count(inserted(accounts)) == 0': passed,
      'isEmpty(inserted(entries)) == true': passed,
    },
    expectByDetection: {
      // Over a value-detection engine this is a floor, not a count: a rewrite
      // to identical values would leave it at zero. Answering `0` here is the
      // shape of every idempotency check that passes for the wrong reason.
        // `except audit_log` keeps this a statement about the axis it is
        // testing. That table has no key, which makes a whole-scope question
        // unanswerable on the MVCC engines for an unrelated reason — carved out
        // here, and tested on its own as `a whole-scope question with a keyless
        // table in scope`, rather than letting one case fail for two reasons.
      'count(changes(* except audit_log)) == 0': { write: passed, value: unevaluable },
      'isEmpty(changes(* except audit_log)) == true': { write: passed, value: unevaluable },
    },
    shape: {},
  },
  {
    name: 'a rolled-back write',
    because: 'an aborted transaction wrote nothing, and no engine may claim otherwise',
    seed: SEED,
    act: [
      'BEGIN',
      `UPDATE accounts SET balance = '1.00' WHERE id = 'acc_alice'`,
      `INSERT INTO entries (id, account_id, amount, kind) VALUES ('ent_gone', 'acc_alice', '9.00', 'X')`,
      'ROLLBACK',
    ],
    // An aborted transaction never reaches the log at all, so even the engine
    // that sees every write sees none of these.
    mutationsWhenTransactional: [],
    expect: {
      'count(inserted(entries)) == 0': passed,
    },
    expectByDetection: {
        // `except audit_log` keeps this a statement about the axis it is
        // testing. That table has no key, which makes a whole-scope question
        // unanswerable on the MVCC engines for an unrelated reason — carved out
        // here, and tested on its own as `a whole-scope question with a keyless
        // table in scope`, rather than letting one case fail for two reasons.
      'count(changes(* except audit_log)) == 0': { write: passed, value: unevaluable },
      'count(updated(accounts).where(balance = "1.00")) == 0': { write: passed, value: unevaluable },
    },
    shape: {},
  },
  {
    name: 'exact numeric and jsonb',
    because: 'a value that round-trips through a JS number is a wrong value',
    seed: SEED,
    act: [
      `UPDATE accounts SET exact_value = '9007199254740993.0000000001',
         meta = '{"b":2,"a":1}'::jsonb WHERE id = 'acc_alice'`,
    ],
    expect: {
      'after(single(rows(accounts, id = "acc_alice")).exact_value) == "9007199254740993.0000000001"':
        passed,
      // jsonb compares structurally, so key order must not decide it.
      'after(single(rows(accounts, id = "acc_alice")).meta) == "{\\"a\\": 1, \\"b\\": 2}"': passed,
    },
    shape: { 'accounts:update:acc_alice': ['exact_value', 'meta'] },
  },
  {
    name: 'a table with no key',
    because: 'rows that cannot be paired must still be counted, and the run must say so',
    seed: SEED,
    act: [`INSERT INTO audit_log (note) VALUES ('refund requested')`],
    expect: {
      'count(inserted(audit_log)) == 1': passed,
      'count(inserted(accounts)) == 0': passed,
      // A question that is structurally empty on a keyless table rather than
      // merely imprecise: nothing can pair such a row to a previous version, so
      // `updated` answers 0 however much happened. The insert asserted above
      // proves this is not a blanket refusal.
      //
      // `count(deleted(audit_log)) == 0` belongs here too and is deliberately
      // absent: it is `passed` on snapshot-diff, which re-reads the table and
      // sees the multiset deficit, and `unevaluable` on the MVCC engines, which
      // skip the key read entirely. That is a real capability difference on a
      // *row-identity* axis this harness cannot yet express — and writing it as
      // `expectByDetection` would state the wrong reason, which is the one thing
      // this suite exists to forbid. Covered by unit test instead, until the
      // axis exists here.
      'isEmpty(updated(audit_log)) == true': unevaluable,
      // And a whole-scope question, with this table swept into the default
      // `allTables` scope, cannot be answered by anything: the MVCC engines
      // cannot see a departure from it, and the value-detection engine cannot
      // tell a redundant write from no write. Two different reasons, one
      // verdict — the contract is about what a consumer may conclude, not
      // about how an engine got there.
      'hasWrite(changes(*)) == false': unevaluable,
    },
  },
  {
    name: 'a composite key updated',
    because: 'a composite key must pair the row, not look like a delete plus an insert',
    seed: [...SEED, `INSERT INTO holds (account_id, ref, amount) VALUES ('acc_alice', 'h1', '10.00')`],
    act: [`UPDATE holds SET amount = '25.00' WHERE account_id = 'acc_alice' AND ref = 'h1'`],
    expect: {
      'count(inserted(holds)) == 0': passed,
      'count(deleted(holds)) == 0': passed,
      'delta(single(updated(holds)).amount) == "15.00"': passed,
    },
    expectByDetection: {
      'count(updated(holds)) == 1': { write: passed, value: unevaluable },
    },
    shape: { 'holds:update:acc_alice|h1': ['amount'] },
  },
  {
    name: 'an assertion that is simply wrong',
    because: 'a failure has to be a failure on every engine, with the same actual value',
    seed: SEED,
    act: [`UPDATE accounts SET balance = '960.00' WHERE id = 'acc_alice'`],
    expect: {
      'after(single(rows(accounts, id = "acc_alice")).balance) == "999.00"': failed('960.00'),
    },
    expectByDetection: {
      'count(updated(accounts)) == 2': { write: failed('1'), value: unevaluable },
    },
  },
  {
    name: 'a misspelled table',
    because:
      'the typo that used to pass: an assertion over a table nobody has must never be satisfied ' +
      'by finding nothing',
    seed: SEED,
    act: [`INSERT INTO entries (id, account_id, amount, kind) VALUES ('ent_1', 'acc_alice', '1.00', 'X')`],
    expect: {
      'count(inserted(entires)) == 0': unevaluable,
      'count(inserted(entries)) == 1': passed,
    },
  },

  {
    name: 'a boolean in the primary key',
    because:
      'a bool reads `t` from a SELECT and decodes as `true` from the WAL. An engine matching ' +
      'one against the other finds nothing, and reports a quiet database over a real write — ' +
      'the exact failure this whole tool exists to prevent',
    seed: [...SEED, `INSERT INTO flags VALUES (1, true, 'before')`],
    act: [`UPDATE flags SET note = 'after' WHERE id = 1 AND active = true`],
    expect: {
      'count(inserted(flags)) == 0': passed,
      'after(single(rows(flags, id = "1", active = "t")).note) == "after"': passed,
      'before(single(rows(flags, id = "1", active = "t")).note) == "before"': passed,
    },
    shape: { 'flags:update:1|t': ['note'] },
    mutationsWhenTransactional: ['flags:update:1|t'],
  },
  {
    name: 'a bit string as the primary key',
    because:
      'the decoder frames a bit as `B\'10101010\'` where the wire says `10101010`. Same ' +
      'failure as the boolean, and there are more types like this than anyone can enumerate ' +
      'from memory — which is why the key must not come from the decoder at all',
    seed: [...SEED, `INSERT INTO masks VALUES (B'10101010', 'before')`],
    act: [`UPDATE masks SET note = 'after' WHERE mask = B'10101010'`],
    expect: {
      'after(single(rows(masks, mask = "10101010")).note) == "after"': passed,
    },
    shape: { 'masks:update:10101010': ['note'] },
    mutationsWhenTransactional: ['masks:update:10101010'],
  },

  {
    name: 'a TRUNCATE inside the step',
    because:
      'a scan taken before the step held ACCESS SHARE on every watched table, so a TRUNCATE ' +
      'queued behind it until the idle timeout killed the capture — both engines died. It has ' +
      'to complete, and the run has to survive it',
    seed: SEED,
    act: [`TRUNCATE entries`],
    expect: {
      'count(inserted(entries)) == 0': passed,
    },
    /*
     * The engines legitimately see different amounts of this, and the shapes
     * are not pinned for that reason. An engine that materialises the table
     * before the step has the deleted rows; one that reconstructs them from a
     * held snapshot does not, because PostgreSQL hands an older snapshot a
     * truncated table as *empty* rather than raising.
     *
     * What they must agree on is saying so. Every engine that lost rows here
     * reports `scope-truncated`, which escalates the run to `undecided`, so
     * nobody is handed a confident "nothing happened".
     */
    shapeUnpinned: 'a rewritten table is visible to different engines in different amounts',
  },

  {
    name: 'a row that exists and was not written',
    because:
      '`rows(...)` means "matching rows, whether or not they changed". Answered from the change ' +
      'set it is a synonym for `changes(...)`, and `count(rows(t, pred)) == 0` then passes over ' +
      'a row that is plainly there — the same shape as an assertion about a misspelled table',
    seed: SEED,
    act: [`INSERT INTO entries (id, account_id, amount, kind) VALUES ('ent_1', 'acc_alice', '-40.00', 'DEBIT')`],
    expect: {
      // `acc_shop` was seeded and this step did not touch it.
      'count(rows(accounts, id = "acc_shop")) == 1': passed,
      'after(single(rows(accounts, id = "acc_shop")).balance) == "0.00"': passed,
      // Both images are the current row, so nothing moved — which is true.
      'delta(single(rows(accounts, id = "acc_shop")).balance) == "0.00"': passed,
      'count(rows(accounts)) == 2': passed,
      // ...and a row that really is absent still counts as absent.
      'count(rows(accounts, id = "acc_nobody")) == 0': passed,
    },
    shape: { 'entries:insert:ent_1': ['id', 'account_id', 'amount', 'kind'] },
    mutationsWhenTransactional: ['entries:insert:ent_1'],
  },

  {
    name: 'a primary key that is masked',
    because:
      'identity is a fact about the row and redaction is about what the reader may see. ' +
      'Deriving the key from the already-masked row collapses every key to one placeholder, ' +
      'so nothing pairs — measured: one UPDATE came back as `kind: insert`, `before: null`, ' +
      'no warning, the tool saying a row was created when it was modified',
    seed: [...SEED, `INSERT INTO people VALUES ('alice@example.com', 'free')`],
    maskColumns: ['email'],
    act: [`UPDATE people SET plan = 'pro' WHERE email = 'alice@example.com'`],
    expect: {
      'count(inserted(people)) == 0': passed,
      'before(single(rows(people, plan = "pro")).plan) == "free"': passed,
      'after(single(rows(people, plan = "pro")).plan) == "pro"': passed,
    },
    // The key is still redacted in what is reported — only the pairing used the
    // real value, and it never leaves the adapter.
    shape: { 'people:update:••••••••': ['plan'] },
    mutationsWhenTransactional: ['people:update:••••••••'],
  },

  {
    name: 'a change confined to a masked column',
    because:
      'redaction hides the value, not the fact that it moved. Comparing the redacted images ' +
      'puts the same placeholder on both sides, so the one column that changed looks equal ' +
      'and the row is reported as written-but-unchanged — measured: changedColumns came back ' +
      '[] for an UPDATE that really did rewrite the column. The engine must compare the real ' +
      'values and report only the placeholder',
    seed: [...SEED, `INSERT INTO people VALUES ('alice@example.com', 'free')`],
    maskColumns: ['plan'],
    act: [`UPDATE people SET plan = 'pro' WHERE email = 'alice@example.com'`],
    expect: {
      // The row is reported as modified rather than created...
      'count(inserted(people)) == 0': passed,
      // ...and no comparison against the column can be decided, in either
      // direction. Not the real value, and not the placeholder either: a run
      // that answered `== "••••••••"` with `passed` is one where an assertion
      // can be written against the redaction, kept, and green forever.
      'after(single(rows(people, email = "alice@example.com")).plan) == "pro"': unevaluable,
      'after(single(rows(people, email = "alice@example.com")).plan) == "••••••••"': unevaluable,
      // `!=` too, and this is the one that matters: a guard applied after the
      // negation turns "cannot tell" into `true`, so a suite of `!=` over
      // masked columns goes green precisely because nothing can be seen.
      'after(single(rows(people, email = "alice@example.com")).plan) != "free"': unevaluable,
      // The predicate is refused at the database site as well. Answering it
      // there confirms or denies a redacted value by row count — an oracle
      // driven by a file that came out of the repository.
      'count(rows(people, plan = "pro")) == 1': unevaluable,
    },
    expectByDetection: {
      'count(updated(people)) == 1': { write: passed, value: unevaluable },
    },
    shape: { 'people:update:alice@example.com': ['plan'] },
    mutationsWhenTransactional: ['people:update:alice@example.com'],
  },

  // ─── where the engines are allowed to differ ────────────────────────────────

  {
    name: 'a write that changes no value',
    because:
      'the product\'s whole differentiator. A value-detection engine cannot see this and must ' +
      'say so; it must never answer "no write happened", which is the answer that makes an ' +
      'idempotency test pass for the wrong reason',
    seed: SEED,
    act: [`UPDATE accounts SET balance = balance WHERE id = 'acc_alice'`],
    // The write is in the log even though no value moved.
    mutationsWhenTransactional: ['accounts:update:acc_alice'],
    expect: {},
    expectByDetection: {
      // Neither engine reports a *value* change, but only write detection can
      // say so as a count rather than as an absence of evidence.
      'count(updated(accounts).where(balance = "960.00")) == 0': {
        write: passed,
        value: unevaluable,
      },
        // `except audit_log` keeps this a statement about the axis it is
        // testing. That table has no key, which makes a whole-scope question
        // unanswerable on the MVCC engines for an unrelated reason — carved out
        // here, and tested on its own as `a whole-scope question with a keyless
        // table in scope`, rather than letting one case fail for two reasons.
      'hasWrite(changes(* except audit_log)) == true': { write: passed, value: unevaluable },
      'hasWrite(changes(* except audit_log)) == false': { write: failed('true'), value: unevaluable },
      'count(updated(accounts)) == 1': { write: passed, value: unevaluable },
    },
    shapeByDetection: {
      write: { 'accounts:update:acc_alice': [] },
      value: {},
    },
  },
  {
    name: 'a write to an ignored column only',
    because:
      'the write is real and the visible change is empty. An engine that cannot see the write ' +
      'reports nothing, which is why isEmpty() is the wrong tool for idempotency',
    seed: SEED,
    act: [`UPDATE accounts SET updated_at = now() + interval '1 second' WHERE id = 'acc_alice'`],
    expectByDetection: {
      'hasWrite(changes(accounts)) == true': { write: passed, value: unevaluable },
      'count(updated(accounts)) == 1': { write: passed, value: unevaluable },
    },
    // Both engines see the row change; only the ignore list decides visibility.
    shape: { 'accounts:update:acc_alice': ['updated_at'] },
    expect: {},
  },
  {
    name: 'a row inserted and deleted in one transaction',
    because:
      'it left no trace in the table and no visible row version. Only a log-reading engine can ' +
      'know it happened; the others are right to report nothing',
    seed: SEED,
    act: [
      'BEGIN',
      `INSERT INTO entries (id, account_id, amount, kind) VALUES ('ent_ghost', 'acc_alice', '5.00', 'X')`,
      `DELETE FROM entries WHERE id = 'ent_ghost'`,
      'COMMIT',
    ],
    expect: {
      // Net-wise nothing changed: the row was not there before and is not there
      // now. Every engine is right to report no change — mvcc-xmin because no
      // row version survived for it to find, wal because two cancelling writes
      // net to nothing.
      'count(inserted(entries)) == 0': passed,
      'count(deleted(entries)) == 0': passed,
    },
    expectByDetection: {
      'count(changes(entries)) == 0': { write: passed, value: unevaluable },
    },
    // ...but a transactional engine watched it happen, and this is the only
    // place in the contract where that fact can live.
    mutationsWhenTransactional: ['entries:insert:ent_ghost', 'entries:delete:ent_ghost'],
  },
];

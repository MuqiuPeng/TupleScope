/**
 * What the database did — the product's single most important type.
 *
 * A ChangeSet describes *changes*, not snapshots. Taking a snapshot before and
 * after is one way to obtain one; reading xmin against a held MVCC snapshot is
 * another; decoding the WAL is a third. Nothing downstream — assertions,
 * dashboards, the UI, the CLI's JSON output, run history — is allowed to know
 * which was used, beyond the `captureMethod` label it carries for provenance.
 *
 * The obvious alternative — model this as `diff(before, after)` and store both
 * snapshots — works right up until you want a cheaper or more faithful capture,
 * at which point every consumer has to change with it.
 */

import type { KeyStrategy, Row, RowKey } from './value.js';

/** How the changes were obtained. Provenance only — consumers branch on `detection`. */
export type CaptureMethod =
  /** Held REPEATABLE READ snapshot + `pg_visible_in_snapshot(xmin, snap)`. Default. */
  | 'mvcc-xmin'
  /** Full before/after row comparison. Fallback for tables xmin cannot serve. */
  | 'snapshot-diff'
  /** Logical decoding. Highest fidelity; needs `wal_level=logical`. */
  | 'wal';

/**
 * Whether the engine observed *writes* or *value differences*. Not cosmetic.
 *
 *   UPDATE t SET status = status
 *
 * is a write that changes nothing. `write` detection reports it; `value`
 * detection cannot see it at all. Every count-based assertion
 * (`inserted(x).count == 1`, `changes(x).isEmpty()`) means something different
 * under each, so idempotency checks — the case where a redundant write is
 * exactly the bug — are only sound under `write`.
 *
 * An assertion that needs `write` and is handed `value` must fail loudly. It
 * must never silently degrade: a green CI run that could not have detected the
 * failure is worse than no check.
 */
export type Detection = 'write' | 'value';

/**
 * Whether the engine preserved the history of how a row got where it is, or
 * only where it ended up.
 *
 * Orthogonal to `detection`, and neither axis subsumes the other. Given
 * `balance 100 → 80 → 100` in one step:
 *
 *   snapshot-diff   value / net            sees nothing at all
 *   mvcc-xmin       write / net            knows the row was written; not how often
 *   wal             write / transactional  sees both updates, in order
 *
 * `mvcc-xmin` occupies a cell that neither axis alone describes, which is why
 * there are two of them.
 *
 * A consumer that needs ordering must ask for it by capability — is the history
 * there? — and never by engine name. The moment a consumer says
 * `if (captureMethod === 'wal')`, the contract has stopped doing its job and is
 * merely being worked around.
 */
export type Fidelity = 'net' | 'transactional';

/** Which rows the engine was looking at. Narrowing this changes what absence means. */
export interface CaptureScope {
  /**
   * Where the watched tables actually live, resolved when the scope was built.
   *
   * Not decoration. Nothing else in this contract records it — a table name
   * alone is only unambiguous inside the connection that produced it — so a
   * statement or a link built from a `RowChange` without it addresses whatever
   * the *reader's* `search_path` resolves. Measured: a
   * `SELECT * FROM "wallets" WHERE "id" = 'wal_alice'` generated against
   * `tenant_a` returns `tenant_b`'s row, with a different balance and no
   * error, in a session whose search path differs.
   */
  schema: string;
  /** The database the scope was built against, for the same reason. */
  database: string;
  tables: ReadonlyArray<TableScope>;
  /**
   * True when every table in the schema was observed rather than a declared
   * subset. This is the default, because a hand-picked list quietly hides
   * whatever it forgot. The UI states the scope either way.
   */
  allTables: boolean;
}

export interface TableScope {
  table: string;
  /** SQL predicate the observation was narrowed by, if any. See `left-scope`. */
  where?: string;
  /** Columns excluded from *visible* change, never from `hasWrite`. */
  ignoreColumns: ReadonlyArray<string>;
  /** Columns whose values are redacted before they leave the adapter. */
  maskedColumns: ReadonlyArray<string>;
  keyStrategy: KeyStrategy;
  /**
   * Whether a row leaving this table can be observed at all, on the engine that
   * produced this run.
   *
   * Not derivable from `keyStrategy`, which is why it is its own field: all
   * three engines report `full-row-multiset` for a table with no primary key
   * and no unique index, and then behave differently. The MVCC engines skip
   * such a table's key read entirely, so a DELETE leaves no trace anywhere in
   * `changes`; snapshot-diff re-reads the table and sees the multiset deficit,
   * so the same DELETE is reported. `updated` is lost with it — a change to a
   * keyless row is reported as an insert, because there is no previous version
   * to pair it against.
   *
   * Absent means observable, so a run stored before this field existed keeps its
   * meaning rather than acquiring a refusal it never had.
   */
  departuresObservable?: boolean;
}

/**
 * What happened to one row.
 *
 * `left-scope` exists because a filtered observation makes *absence* ambiguous:
 * with `where customer_id = 7`, a row that vanishes may have been deleted, or
 * may have had its `customer_id` changed. Those are different events and a
 * refund tool must not conflate them, so the engines emit `left-scope` for the
 * second.
 *
 * `entered-scope` is its mirror and is **never emitted, by design** — the
 * symmetry the name suggests does not exist in the data. Presence is not
 * ambiguous the way absence is: the before-image is read *by key, with no watch
 * predicate*, so a row that existed outside the scope is still found and still
 * pairs. It arrives as an ordinary `update` whose predicate column moved, which
 * is both true and more legible than a fifth kind would be. Measured, not
 * assumed — see `mvcc-adapter.test.ts`, 'calls a row entering the watch
 * predicate an update, not an insert', written after a review claimed such a
 * row was indistinguishable from a genuine insert.
 *
 * The variant stays in the union rather than being removed: taking a member out
 * breaks every consumer that switched exhaustively on `kind` just as surely as
 * adding one would, and it costs nothing to keep a documented dead branch.
 */
export type ChangeKind =
  | 'insert'
  | 'update'
  | 'delete'
  | 'entered-scope'
  | 'left-scope'
  /**
   * A row that exists and was not written.
   *
   * Never appears in `ChangeSet.changes` — that is a set of changes, and this
   * is the absence of one. It exists because `rows(...)` selects rows whether
   * or not they changed, and such a row still has to be a `RowChange` for
   * `delta(...)` and `single(...).column` to read it. Both images are the
   * current row, so a delta over it is zero, which is the truth.
   */
  | 'unchanged';

export interface RowChange {
  table: string;
  /** `null` only under the `full-row-multiset` key strategy. */
  key: RowKey | null;
  kind: ChangeKind;
  /** Absent for `insert` and `entered-scope`. */
  before: Row | null;
  /** Absent for `delete` and `left-scope`. */
  after: Row | null;

  /**
   * Columns whose values differ, before `ignoreColumns` is applied.
   *
   * Kept separate from `visibleColumns` so that noise filtering can never
   * change what the engine reports as having happened.
   */
  changedColumns: ReadonlyArray<string>;
  /** `changedColumns` minus the table's `ignoreColumns`. What the UI renders. */
  visibleColumns: ReadonlyArray<string>;

  /**
   * The row was written to. Under `write` detection this is true even when no
   * column value differs; under `value` detection it is inferred and therefore
   * only as good as the values.
   *
   * Idempotency assertions read this field, never `visibleColumns` — otherwise
   * ignoring `updated_at` turns "the retry wrote to the database again" into a
   * passing test, which is precisely the bug those tests exist to catch.
   */
  hasWrite: boolean;
}

/** Something the consumer must be told about, because it bounds what the data proves. */
/**
 * The rows a selector asked for, and whether that is all of them.
 *
 * `complete` is not a detail. A selector is bounded — one that matches a whole
 * table is a mistake worth surfacing rather than a query worth running — and
 * the bound used to be applied silently. Measured on a 1200-row table:
 * `rows(events)` returned 500 and `count(rows(events))` answered 500, a lower
 * bound presented as a total.
 *
 * The rows that *are* here are perfectly good, which is why this is a property
 * of the read and not of the values: an assertion about one row that was read
 * stays decided, and only the questions about the *set* become unanswerable.
 */
export interface RowsRead {
  readonly rows: ReadonlyArray<RowChange>;
  readonly complete: boolean;
  /** How many were returned when `complete` is false, so a message can say so. */
  readonly limit?: number;
}

export interface CaptureWarning {
  code:
    /** Table had no usable key; rows counted but not paired. */
    | 'degraded-row-identity'
    /** Writes were observed during the idle baseline probe, i.e. something else writes here. */
    | 'concurrent-writes-detected'
    /** The observation was truncated. Emitted instead of silently returning less. */
    | 'scope-truncated'
    /** Capture ran, but in a mode that cannot see some class of change. */
    | 'reduced-fidelity'
    /**
     * The connection did not render values under the settings that were pinned.
     *
     * Values are still correct *here* — they came back from this connection and
     * go back to it. What is lost is portability: text produced under unknown
     * settings cannot be handed to a second tool as an address.
     */
    | 'rendering-not-pinned';
  table?: string;
  message: string;
}

/**
 * One write, as it actually happened.
 *
 * `changes` says where each row ended up; this says what was done to get
 * there, in order. The two answer different questions and neither replaces the
 * other — which is why `changes` stays net even on an engine that knows the
 * whole sequence.
 *
 * Deliberately carries **no column values**. Measured against PostgreSQL 17.5,
 * the values in a decoded WAL stream disagree with what a `SELECT` returns
 * (`false` where the row reads `f`), name their types differently (`boolean`
 * where the catalogue says `bool`), and replace a large untouched column with
 * the literal `unchanged-toast-datum`. Values belong to `changes`, which reads
 * them one way for every engine; this list is about sequence and grouping.
 */
export interface Mutation {
  /** Position within this capture, from 0, in the order the writes committed. */
  sequence: number;
  /**
   * The transaction that performed it — rows sharing one were written
   * atomically. `null` when the engine cannot know, which is not the same as
   * "each write was its own transaction".
   */
  transactionId: string | null;
  table: string;
  operation: 'insert' | 'update' | 'delete' | 'truncate';
  /** `null` when the table has no usable row identity. */
  key: RowKey | null;
}

export interface ChangeSet {
  captureMethod: CaptureMethod;
  detection: Detection;
  /**
   * `net` means `changes` is the only view there is: one entry per row, showing
   * where it ended up. `transactional` means the engine also observed the order
   * and grouping of the writes that got it there.
   *
   * `changes` stays net-shaped under both. A mutation list in its place would
   * make `single(updated(wallets))` match twice under an engine that saw two
   * writes to one row and once under an engine that saw the row change — the
   * same scenario answering differently depending on how it was watched, which
   * is the exact thing this contract exists to prevent.
   */
  fidelity: Fidelity;
  scope: CaptureScope;
  changes: ReadonlyArray<RowChange>;
  /**
   * Every write in order, present only when `fidelity` is `transactional`.
   *
   * A consumer that needs ordering asks whether this is here — never which
   * engine ran. Its absence is a fact about what was observable, not a gap to
   * work around: an engine reporting `net` genuinely does not know how many
   * times a row was written or in what order relative to another table, and
   * inventing a sequence for it would be worse than having none.
   *
   * It also carries the one thing a net view cannot express at all. A row
   * inserted and deleted inside one transaction is not a net change, so it is
   * correctly absent from `changes` on every engine — and appears only here.
   */
  mutations?: ReadonlyArray<Mutation>;
  /**
   * The session settings the captured text was rendered under.
   *
   * A value's `text` is not a property of the value alone; it is the value plus
   * the settings of the session that printed it. The same `timestamptz` prints
   * as `2024-03-01 12:00:00+00` under `DateStyle=ISO` and `01/03/2024 12:00:00
   * GMT` under `SQL,DMY`, and a statement built from the second addresses a
   * different row, or none.
   *
   * Recorded rather than assumed, so a consumer building a statement from a
   * stored run can *check* instead of trusting that whatever produced the file
   * was pinned. The keys are the Postgres setting names; the adapter reports
   * what it measured, not what it asked for.
   */
  rendering: Readonly<Record<string, string>>;
  /**
   * Never empty-by-omission. If the engine could not observe something it says
   * so here; a consumer may treat an empty `changes` as "nothing happened" only
   * when `warnings` is also empty.
   */
  warnings: ReadonlyArray<CaptureWarning>;
  /** Wall-clock cost of observation, so the UI can show what watching cost. */
  durationMs: number;
}

/**
 * The adapter contract.
 *
 * Everything Postgres-specific lives behind this. Note the shape: the caller
 * hands over the work to be observed rather than calling `before()` and
 * `after()` itself, because the MVCC engine has to hold a transaction open
 * across the request and must be able to release it on any exit path.
 */
export interface DatabaseAdapter {
  readonly captureMethod: CaptureMethod;
  readonly detection: Detection;
  readonly fidelity: Fidelity;

  /**
   * Checks whatever this engine needs from the server, before anything runs.
   *
   * Optional because most engines need nothing. An engine that does — logical
   * decoding needs `wal_level = logical`, which is a server restart — must fail
   * here, where the caller can name the setting and the fix. Left to capture
   * time the same failure arrives mid-scenario, as a raw driver error, and
   * reads as the API under test being broken.
   */
  preflight?(): Promise<void>;

  /**
   * Rows as they are now, for a `rows(...)` selector — whether or not the step
   * changed them.
   *
   * Separate from `capture` because it answers a different question: not "what
   * did this request write" but "what is there". Two things are required of an
   * implementation, and both are the reason this is on the adapter rather than
   * anywhere more convenient:
   *
   *   it reads through the same path as every other value, so `maskColumns`
   *   is inherited rather than bypassed;
   *
   *   it is read-only and its predicate is parameterised — `clauses` is
   *   already split into columns and values precisely so no caller is tempted
   *   to build a statement out of text from a scenario file.
   */
  readRows?(
    table: string,
    clauses: ReadonlyArray<{ column: string; value: string | null }>,
    scope: CaptureScope,
  ): Promise<RowsRead>;

  /** Runs `body` and returns both its result and what the database did meanwhile. */
  capture<T>(
    scope: CaptureScope,
    body: () => Promise<T>,
  ): Promise<{ result: T; changes: ChangeSet }>;

  /**
   * Observes an idle window and reports whether anything wrote to the database
   * anyway. Cheap, and it converts "this tool reports rows I didn't touch" from
   * a bug report into a warning the user understands. Background jobs, session
   * GC and outbox pollers make this common on real dev machines.
   */
  probeBaselineNoise(scope: CaptureScope, windowMs: number): Promise<ChangeSet>;

  listTables(): Promise<ReadonlyArray<string>>;
  close(): Promise<void>;
}

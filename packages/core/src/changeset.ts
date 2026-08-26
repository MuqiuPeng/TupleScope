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

/** Which rows the engine was looking at. Narrowing this changes what absence means. */
export interface CaptureScope {
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
}

/**
 * What happened to one row.
 *
 * `entered-scope` / `left-scope` exist because a filtered observation makes
 * absence ambiguous: with `where customer_id = 7`, a row that vanishes may have
 * been deleted, or may have had its `customer_id` changed. Those are different
 * events and a refund tool must not conflate them. Adding these later would
 * break every consumer that switched exhaustively on `kind`, so they are here
 * from the start even though v0.1 does not yet emit them.
 */
export type ChangeKind =
  | 'insert'
  | 'update'
  | 'delete'
  | 'entered-scope'
  | 'left-scope';

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
export interface CaptureWarning {
  code:
    /** Table had no usable key; rows counted but not paired. */
    | 'degraded-row-identity'
    /** Writes were observed during the idle baseline probe, i.e. something else writes here. */
    | 'concurrent-writes-detected'
    /** The observation was truncated. Emitted instead of silently returning less. */
    | 'scope-truncated'
    /** Capture ran, but in a mode that cannot see some class of change. */
    | 'reduced-fidelity';
  table?: string;
  message: string;
}

export interface ChangeSet {
  captureMethod: CaptureMethod;
  detection: Detection;
  scope: CaptureScope;
  changes: ReadonlyArray<RowChange>;
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

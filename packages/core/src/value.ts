/**
 * Database values, kept at full fidelity.
 *
 * The rule this file exists to enforce: a value never becomes a JS primitive on
 * the way through Core. Flattening decimals to `Number()` is easy to get away
 * with while every amount is a small integer, and not good enough for a tool
 * whose headline example is a ledger:
 *
 *   9007199254740993::bigint    -> Number(...) === 9007199254740992   (wrong)
 *   0.1::numeric + 0.2::numeric -> 0.1 + 0.2 === 0.30000000000000004  (wrong)
 *
 * node-postgres already returns `numeric` and `int8` as strings. The job here
 * is to not undo that. `text` is the authority; `parsed` is a convenience for
 * renderers and MUST NOT be used for equality.
 */

/** A single column value as it came out of the database. */
export interface Value {
  /** The Postgres type name (`numeric`, `timestamptz`, `jsonb`, `_text`, ...). */
  pgType: string;
  /** Canonical text form, exactly as the wire protocol delivered it. NULL is `null`. */
  text: string | null;
  /**
   * Optional decoded form for display only — a Date, a parsed JSON tree, a
   * decimal object. Comparison never reads this field: two Values are equal iff
   * `valuesEqual` says so, which decides under `pgType` semantics.
   */
  parsed?: unknown;
}

/** One row, column name -> value. Column order is not significant. */
export type Row = Readonly<Record<string, Value>>;

/**
 * A row's identity.
 *
 * `columns` is ordered and may hold more than one entry: composite primary keys
 * are ordinary, and assuming a single column named `id` would silently mis-pair
 * rows on any table that has one. `serialized` is a stable string form for use
 * as a Map key — build it from `columns`, never from a JSON dump of the row.
 */
export interface RowKey {
  columns: ReadonlyArray<{ column: string; value: Value }>;
  serialized: string;
}

/**
 * How a row's identity was established, worst case last.
 *
 * `full-row-multiset` is the degenerate path for tables with neither a primary
 * key nor a unique index: rows can be counted but not paired, so an UPDATE is
 * indistinguishable from a DELETE plus an INSERT. Callers must surface that
 * rather than pretending to a precision they do not have.
 */
export type KeyStrategy = 'primary-key' | 'unique-index' | 'full-row-multiset';

/**
 * Compares two values under the semantics of their Postgres type.
 *
 * Implemented by the adapter, declared here so the contract is visible: `jsonb`
 * compares structurally (Postgres reorders object keys, so `{"b":2,"a":1}` comes
 * back as `{"a":1,"b":2}` and a string compare reports a phantom change),
 * `citext` compares case-insensitively, `numeric` compares numerically rather
 * than lexically (`1.10` equals `1.1`), and arrays compare element-wise.
 */
export type ValueComparator = (a: Value, b: Value) => boolean;

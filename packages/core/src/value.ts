/**
 * Database values, kept at full fidelity — and honest about what is missing.
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
 *
 * The second rule, which the shape enforces rather than documents: a value that
 * this run does not have carries no `text` at all. It used to carry a
 * placeholder plus a `masked?: true` flag, and every consumer was expected to
 * check the flag before touching the text. Five separate places forgot, in one
 * session — a promoted assertion whose expected literal was the placeholder, a
 * `SELECT` addressing a row by it, an `UPDATE` reported as an `insert` because
 * every masked key collapsed to the same string, an ordered mutation list that
 * printed the real email, and a comparison that made a changed masked column
 * look unchanged. None of them failed loudly; each produced something that
 * looked right. Making `text` reachable only through the `visible` arm turns
 * every one of those into a compile error.
 */

/** A value this run has. */
export interface VisibleValue {
  readonly state: 'visible';
  /** The Postgres type name (`numeric`, `timestamptz`, `jsonb`, `_text`, ...). */
  readonly pgType: string;
  /** Canonical text form, exactly as the wire protocol delivered it. NULL is `null`. */
  readonly text: string | null;
  /**
   * Optional decoded form for display only — a Date, a parsed JSON tree, a
   * decimal object. Comparison never reads this field: two values are equal iff
   * the adapter's comparator says so, which decides under `pgType` semantics.
   */
  readonly parsed?: unknown;
}

/**
 * A value withheld on purpose. Unavailable by choice; the fact that it changed
 * is still knowable.
 *
 * `pgType` stays. It comes from the catalogue, is identical for every row of
 * the column, and is knowable from `\d` — redacting a schema fact to protect a
 * value fact is theatre. It also has to be real: one shared placeholder that
 * hardcoded `text` made every masked `numeric` claim to be `text`, which
 * silently changed how it compared, how it rendered, and whether `promote`
 * would treat it as a number.
 *
 * Deliberately absent: `text`, `parsed`, length, hash, prefix, last-4. Each is
 * an oracle and each will be requested.
 */
export interface MaskedValue {
  readonly state: 'masked';
  readonly pgType: string;
}

/**
 * A value this run failed to obtain. Unavailable by accident; whether it
 * changed is not knowable either.
 *
 * Both reasons are per-cell by construction. A read that stopped at a row limit
 * is *not* one of them: what is missing there is whole rows, not a cell, and
 * every cell that was read is perfectly good. That is `RowsRead.complete`, and
 * modelling it here would either mark thousands of readable cells unknown,
 * which is false, or mark none of them and let a count answer from a partial
 * read, which is worse.
 *
 * **Nothing constructs this today, and that is a measured fact rather than an
 * oversight.** `toast-not-carried` could only reach a reported value through a
 * key column, because row images come from the database and not from the
 * decoded log — and a column big enough to be out-of-line TOASTed cannot be a
 * key at all: PostgreSQL refuses the index outright, `index row requires 12816
 * bytes, maximum size is 8191`. Row identity here is always a primary key or a
 * unique index, so the sentinel can never appear in one. `unreadable` has no
 * producer either while every value arrives from the driver as text.
 *
 * The arm stays because it is the shape the answer has to take the moment a
 * capture mode reads row images from the log rather than the database, and
 * because every consumer is already written for it. `value.test.ts` asserts
 * that nothing produces it, so the day something does, that test says so and
 * the paths it makes reachable get their coverage.
 */
export interface UnknownValue {
  readonly state: 'unknown';
  readonly pgType: string;
  readonly reason: UnknownReason;
}

export type UnknownReason =
  /** Logical decoding declined to carry it, and no before-image to repair from. */
  | 'toast-not-carried'
  /** It was read and could not be rendered as text. */
  | 'unreadable';

/**
 * A single column value, and whether this run actually has it.
 *
 *   visible  value available            · did it change? yes
 *   masked   unavailable by choice      · did it change? yes
 *   unknown  unavailable by failure     · did it change? cannot say
 */
export type Value = VisibleValue | MaskedValue | UnknownValue;

/** One row, column name -> value. Column order is not significant. */
export type Row = Readonly<Record<string, Value>>;

// ─── constructors ─────────────────────────────────────────────────────────────

export function visible(pgType: string, text: string | null): VisibleValue {
  return { state: 'visible', pgType, text };
}

/** Per column, never a shared singleton: the type has to be the real one. */
export function masked(pgType: string): MaskedValue {
  return { state: 'masked', pgType };
}

export function unknown(pgType: string, reason: UnknownReason): UnknownValue {
  return { state: 'unknown', pgType, reason };
}

// ─── reading ──────────────────────────────────────────────────────────────────

export function isVisible(value: Value | undefined): value is VisibleValue {
  return value?.state === 'visible';
}

/**
 * The text, or a refusal.
 *
 * For the places that cannot proceed without the real value — a comparison, a
 * statement addressing the row, a promoted literal. `what` names the caller so
 * the message says which question could not be answered rather than just that
 * something was missing.
 */
export function requireText(value: Value | undefined, what: string): string | null {
  if (value === undefined) throw new ValueUnavailable(`${what}: the column was not read`);
  if (value.state === 'visible') return value.text;
  if (value.state === 'masked') {
    throw new ValueUnavailable(
      `${what}: the column is masked at capture, so this run does not have its value`,
    );
  }
  throw new ValueUnavailable(`${what}: the value could not be read (${value.reason})`);
}

/** Thrown by `requireText`. Consumers map it onto their own refusal. */
export class ValueUnavailable extends Error {
  override readonly name = 'ValueUnavailable';
}

/**
 * The text when this run has it, `undefined` when it does not.
 *
 * Deliberately not `null` for the withheld cases: `?.text ?? null` is exactly
 * the idiom that let a masked value read as SQL NULL in six places, and a
 * helper that reproduced it would be the same bug with a nicer name.
 */
export function textIfVisible(value: Value | undefined): string | null | undefined {
  return isVisible(value) ? value.text : undefined;
}

// ─── display ──────────────────────────────────────────────────────────────────

/**
 * What a masked value looks like on screen.
 *
 * A rendering concern, and only that. It is deliberately not stored on the
 * value: a placeholder that travelled with the data is what let an assertion be
 * promoted with the bullets as its expected literal, and what let a `SELECT`
 * address a row by them.
 */
export const MASKED_TEXT = '••••••••';

/** What an unobtainable value looks like on screen. Never bullets: it is not a secret. */
export const UNKNOWN_TEXT = '‹unknown›';

/**
 * One rendering for every surface.
 *
 * The CLI and the web UI disagreed about this for a whole release — the CLI
 * printed bare bullets with no annotation while the web page said "masked at
 * capture" — because each wrote its own.
 */
export function displayText(value: Value | undefined): string {
  if (value === undefined) return UNKNOWN_TEXT;
  switch (value.state) {
    case 'visible':
      return value.text === null ? 'NULL' : value.text;
    case 'masked':
      return MASKED_TEXT;
    case 'unknown':
      return UNKNOWN_TEXT;
  }
}

/**
 * A row key rendered for a human: `wal_alice`, or `12|A` for a composite.
 *
 * One implementation, because there were four — the CLI, the web page, the
 * envelope's mutation sequence and the conformance suite each wrote their own
 * `.text ?? 'NULL'`, and they disagreed about masked values. Never SQL: the
 * string `NULL` is right for a person reading a key column and wrong inside a
 * statement, where it matches no row.
 */
export function keyLabel(key: RowKey | null | undefined): string {
  if (!key || key.columns.length === 0) return '(unkeyed)';
  return key.columns.map((c) => displayText(c.value)).join('|');
}

// ─── identity ─────────────────────────────────────────────────────────────────

/**
 * A row's identity.
 *
 * `columns` is ordered and may hold more than one entry: composite primary keys
 * are ordinary, and assuming a single column named `id` would silently mis-pair
 * rows on any table that has one.
 */
export interface RowKey {
  readonly columns: ReadonlyArray<{ column: string; value: Value }>;
  /**
   * An opaque per-run token that correlates the same row across views.
   *
   * Not the key, not derivable back to it, and not something to put in a
   * statement — which is exactly why it is not called `serialized` any more.
   * The string it replaced was `JSON.stringify` of the *reported* key columns,
   * so under a masked primary key every row in the table produced the identical
   * string. Measured: two rows updated, two changes reported, one distinct key
   * between them — enough for `union` to dedupe them into one and for the
   * ordered mutation list to pair the wrong images.
   *
   * Derived from the real key values with a salt that lives in the adapter for
   * the life of the process and is never serialised, so it is stable within a
   * run, distinct between rows whatever is masked, and useless outside.
   */
  readonly token: string;
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
 *
 * It answers only for two `visible` values. Anything else is not a comparison
 * that can come out true or false, and a comparator that returned a boolean for
 * it would be inventing one.
 */
export type ValueComparator = (a: VisibleValue, b: VisibleValue) => boolean;

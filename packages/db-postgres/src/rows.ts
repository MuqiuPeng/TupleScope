/**
 * The plumbing both engines need and neither engine owns.
 *
 * Reading a Postgres row into a `Row`, deriving its key, quoting an
 * identifier, deciding whether two raw values are the same text — none of that
 * has anything to do with *how* an engine noticed the row changed. Keeping it
 * here is also a check on the contract: if two engines could only coexist by
 * copying half of each other, the shared thing was never really shared.
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Row, RowKey, Value } from '@tuplescope/core';
import { isVisible, masked as maskedValue, visible } from '@tuplescope/core';
import { readTypeNames } from './introspect.js';

/** Every value arrives as raw text; nothing is parsed into a JS type on the way in. */
export const RAW_TEXT_TYPES = { getTypeParser: () => (value: string) => value };

/**
 * The most rows a `rows(...)` selector will read.
 *
 * A selector picks out the row an assertion is about. One that matches a whole
 * table is a mistake, and returning ten thousand rows would hide it behind a
 * slow run rather than surfacing it.
 */
export const ROWS_LIMIT = 500;

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Raw-text comparison, used only to decide which columns changed within a row.
 * Semantic comparison (jsonb key order, numeric scale, citext case) belongs to
 * the assertion layer, which knows the type and the intent.
 *
 * Only ever called on the *raw* images. Two values that are not `visible` carry
 * no text to compare, and treating them as equal is precisely how an update
 * confined to a masked column came back with `changedColumns: []`.
 */
export function valuesLookEqual(a: Value | undefined, b: Value | undefined): boolean {
  if (!isVisible(a) || !isVisible(b)) return a?.state === b?.state && a?.state !== 'unknown';
  return a.text === b.text;
}

/** Turns result sets into `Row`s, with the type-name lookup cached across captures. */
export class RowReader {
  private typeNames?: Map<number, string>;
  /** In memory, for the life of this reader. Never serialised, never logged. */
  private readonly salt = randomBytes(32);

  async ensureTypes(client: pg.PoolClient): Promise<void> {
    if (!this.typeNames) this.typeNames = await readTypeNames(client);
  }

  typeName(oid: number): string {
    return this.typeNames?.get(oid) ?? 'unknown';
  }

  toRow(
    fields: ReadonlyArray<pg.FieldDef>,
    raw: Record<string, string | null>,
    masked: ReadonlySet<string>,
  ): Row {
    const row: Record<string, Value> = {};
    for (const field of fields) {
      // Per column, so a masked `numeric` still says `numeric`. One shared
      // placeholder that hardcoded `text` made every masked column lie about
      // its type, which changed how it compared and how it rendered.
      const pgType = this.typeName(field.dataTypeID);
      row[field.name] = masked.has(field.name)
        ? maskedValue(pgType)
        : visible(pgType, raw[field.name] ?? null);
    }
    return row;
  }

  /**
   * The reported key: redacted columns, and a token derived from the real ones.
   *
   * Two rows, `raw` and `shown`, because the two halves come from opposite
   * sides. What is *shown* must be redacted or a masked primary key is back on
   * screen. What the token is *derived from* must be raw, or every row with a
   * masked key column produces the same token and the views that join on it
   * silently merge distinct rows.
   */
  keyOf(shown: Row, raw: Row, columns: ReadonlyArray<string>): RowKey | null {
    if (columns.length === 0) return null;
    return {
      columns: columns.map((column) => ({ column, value: shown[column]! })),
      token: this.tokenFor(raw, columns),
    };
  }

  /**
   * A stable per-run token for a row.
   *
   * Salted and hashed rather than the key itself: the previous form was the
   * key's JSON, which is a locator, and a locator that travels in every report
   * is one nobody decided to disclose. The salt lives here for the life of the
   * reader and is never serialised, so the token is meaningless outside the run
   * that produced it.
   */
  tokenFor(raw: Row, columns: ReadonlyArray<string>): string {
    return createHash('sha256')
      .update(this.salt)
      .update(serializeKey(raw, columns))
      .digest('hex')
      .slice(0, 24);
  }
}

/**
 * The internal pairing key: the real values, JSON-encoded.
 *
 * Never leaves the adapter — it is a `Map` key, and it is built from the raw
 * image precisely so that two rows differing only in a masked column remain two
 * rows. `RowKey.token` is what a consumer gets.
 */
export function serializeKey(row: Row, columns: ReadonlyArray<string>): string {
  return JSON.stringify(
    columns.map((column) => {
      const value = row[column];
      // Tagged by state, so a genuine NULL and a value that could not be read
      // do not pair with each other.
      if (isVisible(value)) return [column, 'v', value.text];
      return [column, value?.state ?? 'absent', null];
    }),
  );
}

/**
 * The inverse of `serializeKey`, so the encoding has exactly one definition.
 *
 * It used to be read by hand, at the one call site that needs the values back
 * — `JSON.parse(key).map((k) => k[1])` — and that hand-read broke silently the
 * moment the encoding gained a field: `k[1]` became the state tag, every
 * before-image lookup bound the string `v` as its key, and every `UPDATE` came
 * back as an `insert` with no before-image.
 *
 * `null` when any column is not `visible`: a value this run does not have
 * cannot be bound as a query parameter, and substituting anything for it would
 * address a different row.
 */
export function parseKey(serialized: string): Array<string | null> | null {
  const parts = JSON.parse(serialized) as Array<[string, string, string | null]>;
  if (parts.some(([, state]) => state !== 'v')) return null;
  return parts.map(([, , text]) => text);
}

/**
 * The one place a statement is rendered.
 *
 * There were two: the adapter quoted identifiers for the queries it runs, and
 * the web page quoted identifiers *and* literals for the SELECT it puts on the
 * clipboard. They disagreed in three ways that matter, and only one of them was
 * visible — the page qualified the schema and the adapter did not, the page
 * emitted `col = NULL` for a null key, and neither escaped a backslash. Two
 * implementations that must agree are two implementations that will not.
 *
 * Everything here renders text a *second tool* will run. The values in it came
 * out of a capture session, so they are only portable if that session pinned
 * its rendering settings — see `ChangeSet.rendering`, which records what was
 * actually used so a consumer can check rather than trust.
 */

import type { Value } from './value.js';
import { isVisible } from './value.js';

/** Refused rather than escaped: PostgreSQL text cannot hold one. */
export class UnrenderableValue extends Error {
  override readonly name = 'UnrenderableValue';
}

export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new UnrenderableValue('an identifier contains a NUL byte');
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A string literal that means the same thing under either
 * `standard_conforming_strings`.
 *
 * Doubling the quote is the easy half. The backslash is the half that gets
 * missed: with `standard_conforming_strings = off` a backslash in an ordinary
 * literal is an escape, so `'back\slash'` addresses something else. Measured on
 * PostgreSQL 16 against a row whose key really is `back\slash`: `E'back\\slash'`
 * found it under both settings, and `'back\slash'` found nothing under `off`.
 *
 * So `E'…'` whenever a backslash is present, and only then — an unconditional
 * `E'…'` would be correct too, but it makes every ordinary statement look like
 * it is doing something clever.
 */
export function quoteLiteral(text: string): string {
  if (text.includes('\0')) throw new UnrenderableValue('a value contains a NUL byte');
  const escaped = text.replace(/'/g, "''");
  return escaped.includes('\\') ? `E'${escaped.replace(/\\/g, '\\\\')}'` : `'${escaped}'`;
}

/** `"public"."wallets"` — always qualified, never bare. */
export function quoteRelation(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * How a key column is matched.
 *
 * `is-not-distinct-from` exists for exactly one reason: `col = NULL` is UNKNOWN
 * in three-valued logic, so it matches nothing while looking like a valid
 * statement. The web page emitted it, and the row it was meant to open came
 * back empty with no error to explain why.
 */
export type PredicateOp = '=' | 'is-not-distinct-from';

export interface PredicateColumn {
  readonly name: string;
  readonly value: Value;
}

/** `"id" = 'wal_alice'`, or `"seat" IS NOT DISTINCT FROM NULL`. */
export function renderPredicate(columns: ReadonlyArray<PredicateColumn>): string {
  if (columns.length === 0) throw new UnrenderableValue('a predicate needs at least one column');
  return columns
    .map(({ name, value }) => {
      if (!isVisible(value)) {
        throw new UnrenderableValue(
          `\`${name}\` is ${value.state === 'masked' ? 'masked at capture' : `unreadable (${value.reason})`}, ` +
            'so no statement can address the row by it',
        );
      }
      // Null takes the operator that is true for null, not the one that is
      // UNKNOWN for it. PostgreSQL 15's `NULLS NOT DISTINCT` makes a nullable
      // unique key a real thing, so this is not only defensive.
      if (value.text === null) return `${quoteIdent(name)} IS NOT DISTINCT FROM NULL`;
      return `${quoteIdent(name)} = ${quoteLiteral(value.text)}`;
    })
    .join(' AND ');
}

/** `SELECT * FROM "public"."wallets" WHERE "id" = 'wal_alice';` */
export function renderSelect(
  schema: string,
  table: string,
  columns: ReadonlyArray<PredicateColumn>,
): string {
  return `SELECT * FROM ${quoteRelation(schema, table)} WHERE ${renderPredicate(columns)};`;
}

/**
 * The refusal a second tool must run before the statement.
 *
 * `IS DISTINCT FROM`, not `<>`. Measured on PostgreSQL 16: with
 * `search_path` naming nothing that exists, `current_schema()` is NULL, so
 * `current_schema() <> 'public'` is NULL, the `IF` does not fire, and the
 * statement runs against whatever the connection actually is.
 *
 * And no `current_schema()` comparison at all. The statement above is
 * schema-qualified, so the search path cannot change which table it reads —
 * measured, under a deliberately broken `search_path` the qualified SELECT
 * still returned the right row. Comparing it would only *refuse working
 * connections*: a `pg_service` entry that legitimately sets its own
 * `search_path` is not wrong, and rejecting it would be. What the check is
 * actually for is whether the table is there at all, which `to_regclass`
 * answers exactly and independently of the search path.
 */
export function renderGuard(database: string, schema: string, table: string): string {
  const relation = quoteLiteral(quoteRelation(schema, table));
  return `DO $$ BEGIN
  IF current_database() IS DISTINCT FROM ${quoteLiteral(database)} THEN
    RAISE EXCEPTION 'StateScope: this connection is database %, but the locator names %', current_database(), ${quoteLiteral(database)};
  END IF;
  IF to_regclass(${relation}) IS NULL THEN
    RAISE EXCEPTION 'StateScope: database % has no table %', current_database(), ${quoteLiteral(`${schema}.${table}`)};
  END IF;
END $$;`;
}

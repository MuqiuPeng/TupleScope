/**
 * Schema facts the capture engine needs: what a row's identity is, and what
 * type each value came back as.
 */

import type { PoolClient } from 'pg';
import type { KeyStrategy } from '@statescope/core';

export interface TableIdentity {
  table: string;
  /** Ordered key columns. Empty when the table has neither a PK nor a unique index. */
  keyColumns: ReadonlyArray<string>;
  /**
   * `pg_type.typname` per key column, in the same order.
   *
   * Needed because a decoded write-ahead log prints some values differently
   * from the way the wire does, and only the type says which.
   */
  keyTypes: ReadonlyArray<string>;
  strategy: KeyStrategy;
}

/**
 * Primary key first, then the narrowest unique index over NOT NULL columns.
 *
 * Assuming every table has a column literally named `id` is the tempting
 * shortcut here. Junction tables, event logs and anything inherited from an
 * older schema routinely have neither that nor a single-column key, and pairing
 * rows by a key that is not one produces confident nonsense.
 *
 * An index qualifies only in full, which is the whole point of the HAVING
 * clause below. Filtering out the columns that disqualify it leaves the
 * survivors behind as a *narrower* key, and a prefix of a unique index is not
 * unique. Measured on `UNIQUE (row_no, seat)` with a nullable `seat`: the key
 * collapsed to `row_no`, two rows shared it, and an UPDATE that touched both
 * came back as one change with no warning — the second row simply was not in
 * the report. A table with no usable key falls back to the full-row multiset,
 * which is less precise but never invents a pairing.
 */
export async function readTableIdentities(
  client: PoolClient,
  tables: ReadonlyArray<string>,
): Promise<Map<string, TableIdentity>> {
  const { rows } = await client.query<{
    table_name: string;
    is_primary: boolean;
    columns: string[];
    types: string[];
  }>(
    `SELECT c.relname                              AS table_name,
            i.indisprimary                         AS is_primary,
            -- ::text matters: array_agg over a name column yields name[] (OID
            -- 1003), for which node-postgres has no array parser -- it hands
            -- back the literal array text instead of an array.
            array_agg(a.attname::text ORDER BY k.ord) AS columns,
            array_agg(t.typname::text ORDER BY k.ord)  AS types
       FROM pg_index i
       JOIN pg_class c        ON c.oid = i.indrelid
       JOIN pg_namespace n    ON n.oid = c.relnamespace
       -- indkey is 0-based and holds the INCLUDE payload after the key
       -- columns. Those are stored, not indexed: they are no part of identity,
       -- and letting one in means a row changes key when its payload changes.
       CROSS JOIN LATERAL unnest(i.indkey[0:i.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, ord)
       -- LEFT, so a column that fails to resolve leaves a NULL here rather
       -- than vanishing; HAVING then rejects the whole index.
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       LEFT JOIN pg_type t      ON t.oid = a.atttypid
      WHERE n.nspname = current_schema()
        AND c.relname = ANY($1::text[])
        AND (i.indisprimary OR (i.indisunique AND i.indpred IS NULL))
      GROUP BY c.relname, i.indisprimary, i.indexrelid, i.indnkeyatts
        -- Every key column resolved to a real column (attnum 0 is an
        -- expression, which has no name to compare on)...
     HAVING count(a.attname) = i.indnkeyatts
        -- ...and every one of them is NOT NULL. A nullable column makes the
        -- index non-unique in practice, because NULLs do not equal each other.
        AND bool_and(a.attnotnull)`,
    [tables],
  );

  const identities = new Map<string, TableIdentity>();
  for (const row of rows) {
    const candidate: TableIdentity = {
      table: row.table_name,
      keyColumns: row.columns,
      keyTypes: row.types,
      strategy: row.is_primary ? 'primary-key' : 'unique-index',
    };
    const existing = identities.get(row.table_name);
    // A real primary key always wins; between unique indexes, prefer the narrowest.
    if (
      !existing ||
      (candidate.strategy === 'primary-key' && existing.strategy !== 'primary-key') ||
      (candidate.strategy === existing.strategy &&
        candidate.keyColumns.length < existing.keyColumns.length)
    ) {
      identities.set(row.table_name, candidate);
    }
  }

  for (const table of tables) {
    if (!identities.has(table)) {
      identities.set(table, { table, keyColumns: [], keyTypes: [], strategy: 'full-row-multiset' });
    }
  }
  return identities;
}

/** OID -> type name, so every value can carry the type it must be compared under. */
export async function readTypeNames(client: PoolClient): Promise<Map<number, string>> {
  const { rows } = await client.query<{ oid: string; typname: string }>(
    `SELECT oid, typname FROM pg_type`,
  );
  return new Map(rows.map((r) => [Number(r.oid), r.typname]));
}

/** Base tables in the current schema. The default scope when no watch list is given. */
export async function listBaseTables(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT c.relname::text AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname NOT LIKE '\\_%'
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.table_name);
}

/**
 * Where a connection actually resolves unqualified names, and to which database.
 *
 * Captured once when a scope is built, because nothing downstream can recover
 * it: a `RowChange` carries a table name, and a table name alone is only
 * unambiguous inside the connection that produced it.
 */
export async function readLocation(
  client: PoolClient,
): Promise<{ schema: string; database: string }> {
  const { rows } = await client.query<{ schema: string; database: string }>(
    'SELECT current_schema() AS schema, current_database() AS database',
  );
  // `current_schema()` is null when the search path names nothing that exists —
  // saying so beats writing "null" into a statement someone will run.
  return { schema: rows[0]?.schema ?? 'public', database: rows[0]?.database ?? '' };
}

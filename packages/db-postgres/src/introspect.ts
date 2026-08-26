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
  strategy: KeyStrategy;
}

/**
 * Primary key first, then the narrowest unique index over NOT NULL columns.
 *
 * Assuming every table has a column literally named `id` is the tempting
 * shortcut here. Junction tables, event logs and anything inherited from an
 * older schema routinely have neither that nor a single-column key, and pairing
 * rows by a key that is not one produces confident nonsense.
 */
export async function readTableIdentities(
  client: PoolClient,
  tables: ReadonlyArray<string>,
): Promise<Map<string, TableIdentity>> {
  const { rows } = await client.query<{
    table_name: string;
    is_primary: boolean;
    columns: string[];
  }>(
    `SELECT c.relname                              AS table_name,
            i.indisprimary                         AS is_primary,
            -- ::text matters: array_agg over a name column yields name[] (OID
            -- 1003), for which node-postgres has no array parser -- it hands
            -- back the literal array text instead of an array.
            array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_index i
       JOIN pg_class c        ON c.oid = i.indrelid
       JOIN pg_namespace n    ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a    ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE n.nspname = current_schema()
        AND c.relname = ANY($1::text[])
        AND (i.indisprimary OR (i.indisunique AND i.indpred IS NULL))
        AND a.attnotnull
      GROUP BY c.relname, i.indisprimary, i.indexrelid`,
    [tables],
  );

  const identities = new Map<string, TableIdentity>();
  for (const row of rows) {
    const candidate: TableIdentity = {
      table: row.table_name,
      keyColumns: row.columns,
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
      identities.set(table, { table, keyColumns: [], strategy: 'full-row-multiset' });
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

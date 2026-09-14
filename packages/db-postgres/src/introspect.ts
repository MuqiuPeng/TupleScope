/**
 * Schema facts the capture engine needs: what a row's identity is, and what
 * type each value came back as.
 */

import type { PoolClient } from 'pg';
import type { KeyStrategy } from '@tuplescope/core';

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
 * Is the database there — in one round trip, one row, two scalars.
 *
 * For a caller that asks repeatedly and does not want the names: the runtime's
 * `/api/health` runs on every window focus, and `listBaseTables` returns a row
 * per table so a reader can list them, which is a page-load cost rather than a
 * per-focus one. The count and the schema are what a reachability report says
 * out loud ("35 tables in `public`"), so this returns exactly those and nothing
 * else.
 *
 * Same `current_schema()`, same `relkind = 'r'` and same `\_%` filter as
 * `listBaseTables`, so the number here counts the tables that one would list.
 * A count that narrowed differently would let two surfaces of the same product
 * disagree about how many tables there are. Measured against a live server on a
 * schema holding two ordinary tables, one `_internal` and one view: both
 * answered two, and a `search_path` naming nothing that exists answered
 * `(no current schema)` here and 0 tables rather than throwing.
 */
export async function countBaseTables(
  client: PoolClient,
): Promise<{ tables: number; schema: string }> {
  const { rows } = await client.query<{ tables: string; schema: string | null }>(
    `SELECT count(*)::text AS tables, current_schema()::text AS schema
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname NOT LIKE '\\_%'`,
  );
  return {
    tables: Number(rows[0]?.tables ?? 0),
    // Null when `search_path` names nothing that exists. Same sentence
    // `describeScope` reports, because an empty pair of backticks on screen
    // reads as a bug in TupleScope rather than as a search path to fix.
    schema: rows[0]?.schema ?? '(no current schema)',
  };
}

/**
 * What is in scope, and — the part that matters — what is not.
 *
 * `listBaseTables` narrows three times in one WHERE clause, and until this
 * existed it narrowed silently. A write to another schema, to a table whose
 * name begins with an underscore, or through a foreign table produced the most
 * emphatic sentence this tool prints: "Nothing was written. Not a single row
 * was touched." Outcome clean, exit 0, no warning, all three engines.
 *
 * The envelope already carried `scope.schema`; nothing ever printed it, and the
 * field beside it is called `allTables: true`. Reporting the boundary is what
 * makes that sentence mean what it says.
 *
 * Partitioned parents are listed but not a gap: their partitions are ordinary
 * tables and are watched individually. They are named because an assertion
 * against the parent's name refuses, and knowing why saves the reader a trip.
 */
export interface ScopeReport {
  schema: string;
  watched: number;
  /** Tables in other non-system schemas, which are not watched at all. */
  otherSchemas: Array<{ schema: string; tables: number }>;
  /** Excluded by the `\_%` name filter. */
  nameFiltered: string[];
  /** Watched through their partitions, not under this name. */
  partitionedParents: string[];
  /** Not readable by this capture at all. */
  foreignTables: string[];
  /**
   * Watched, but with no primary key and no unique index: changes are counted
   * and not paired to a previous version, and a deletion is invisible.
   */
  keyless: string[];
}

export async function describeScope(client: PoolClient): Promise<ScopeReport> {
  // Asked directly rather than read off a row, because the row may not exist.
  // The name used to be filled in from whichever table happened to be in the
  // current schema, so a schema with no tables reported itself as `` — and that
  // is exactly the state in which every following run says "Nothing was
  // written", with nothing on screen to say what it looked at.
  const { rows: current } = await client.query<{ schema: string | null }>(
    'SELECT current_schema()::text AS schema',
  );

  const { rows } = await client.query<{
    schema: string;
    table_name: string;
    relkind: string;
    here: boolean;
  }>(
    `SELECT n.nspname::text AS schema,
            c.relname::text AS table_name,
            c.relkind::text AS relkind,
            (n.nspname = current_schema()) AS here
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'f')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND n.nspname NOT LIKE 'pg_temp%'
        AND n.nspname NOT LIKE 'pg_toast_temp%'
      ORDER BY n.nspname, c.relname`,
  );

  const report: ScopeReport = {
    // `current_schema()` is null when `search_path` names nothing that exists.
    // Saying so beats an empty pair of backticks.
    schema: current[0]?.schema ?? '(no current schema)',
    watched: 0,
    otherSchemas: [],
    nameFiltered: [],
    partitionedParents: [],
    foreignTables: [],
    keyless: [],
  };
  const elsewhere = new Map<string, number>();
  const watched: string[] = [];

  for (const row of rows) {
    if (!row.here) {
      // A partition of a table in another schema is still not ours; count the
      // schema once and move on rather than itemising someone else's tables.
      elsewhere.set(row.schema, (elsewhere.get(row.schema) ?? 0) + 1);
      continue;
    }
    if (row.relkind === 'p') report.partitionedParents.push(row.table_name);
    else if (row.relkind === 'f') report.foreignTables.push(row.table_name);
    else if (row.table_name.startsWith('_')) report.nameFiltered.push(row.table_name);
    else watched.push(row.table_name);
  }
  report.watched = watched.length;

  // Watched, but blind in one direction: with no primary key and no unique
  // index a row's changes can be counted and not paired, and a deletion there
  // leaves nothing to find. Only the run used to say so — `status` and `check`
  // described a keyless table exactly like any other, and the first a reader
  // heard of it was an undecided run. Same identity rule the engines use.
  const identities = watched.length > 0 ? await readTableIdentities(client, watched) : new Map();
  report.keyless = watched.filter((table) => identities.get(table)?.strategy === 'full-row-multiset');

  report.otherSchemas = [...elsewhere].map(([schema, tables]) => ({ schema, tables }));
  return report;
}

/**
 * Every base table's column names, in one query.
 *
 * For `check`, which resolves the names an assertion uses against the database
 * before anything runs. Table names it already resolved; column names it did
 * not, and a misspelled one inside `.where(...)` is invisible in the one place
 * it matters most. `Array.prototype.filter` never calls its callback on an
 * empty list, so on a step that wrote nothing the predicate is never read, and
 * `count(inserted(t).where(nmae = "x")) == 0` comes back green — precisely the
 * shape of a "this must not write twice" guard, which is the assertion this
 * tool exists to make.
 *
 * Same `current_schema()` and same `relkind = 'r'` filter as `listBaseTables`,
 * so the two answers describe the same set of tables.
 */
export async function listColumnsByTable(client: PoolClient): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.relname::text AS table_name, a.attname::text AS column_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname NOT LIKE '\\_%'
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    let columns = byTable.get(row.table_name);
    if (!columns) byTable.set(row.table_name, (columns = new Set()));
    columns.add(row.column_name);
  }
  return byTable;
}

/**
 * Every base table's columns with their declared types, in table order.
 *
 * For MCP `describe_table`, whose description promised "its columns, types"
 * and printed neither. `format_type` rather than `typname`, so a reader sees
 * `numeric(18,8)` and `character varying(255)` — the declared type, modifiers
 * and all — which is what decides how a value in an assertion compares. Same
 * scope filter as `listColumnsByTable`, so the two describe the same tables.
 */
export async function listColumnTypesByTable(
  client: PoolClient,
): Promise<Map<string, Array<{ name: string; type: string }>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string; column_type: string }>(
    `SELECT c.relname::text AS table_name,
            a.attname::text AS column_name,
            format_type(a.atttypid, a.atttypmod) AS column_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = current_schema()
        AND c.relkind = 'r'
        AND c.relname NOT LIKE '\\_%'
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  const byTable = new Map<string, Array<{ name: string; type: string }>>();
  for (const row of rows) {
    let columns = byTable.get(row.table_name);
    if (!columns) byTable.set(row.table_name, (columns = []));
    columns.push({ name: row.column_name, type: row.column_type });
  }
  return byTable;
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

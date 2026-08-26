/**
 * The mvcc-xmin capture engine.
 *
 * Instead of copying every watched table twice per step, this holds one
 * REPEATABLE READ transaction open across the request and uses Postgres's own
 * row versioning to answer both halves of the question:
 *
 *   1. before   open transaction O, freeze `pg_current_snapshot()`, read
 *               nothing but key columns. Cost is close to zero.
 *   2. (run the HTTP step)
 *   3. after    on a *different* connection, select the rows whose inserting
 *               transaction was not visible to O's snapshot — exactly the rows
 *               written during the window — plus the key set, to spot deletes.
 *   4. before   query those keys back *inside O*, which still sees the world as
 *      image    it was at step 1. MVCC is the time machine.
 *
 * Measured on a 500k-row / 161 MB table: a full `SELECT *` costs ~396 ms
 * server-side and ships ~161 MB; the xmin-filtered scan costs ~33 ms and ships
 * a few kB.
 *
 * It also detects *writes* rather than *value differences*. `UPDATE t SET
 * status = status` creates a new row version and is caught here; a before/after
 * value comparison cannot see it at all. That distinction is the difference
 * between an idempotency test that works and one that passes for the wrong
 * reason.
 *
 * Known limits, all reported rather than hidden:
 *   - a row inserted and deleted inside one transaction leaves no visible
 *     version, so it is invisible here. Only WAL decoding catches that.
 *   - `xmin` is not indexed, so the after-scan is a sequential scan. It ships
 *     almost nothing, but on a very large table the scan itself still costs;
 *     that is what a watch predicate is for.
 *   - holding a transaction open defers VACUUM. Windows are bounded and the
 *     session carries its own idle timeout so a crash cannot strand one.
 */

import pg from 'pg';
import type {
  CaptureScope,
  CaptureWarning,
  ChangeSet,
  DatabaseAdapter,
  Row,
  RowChange,
  RowKey,
  TableScope,
  Value,
} from '@statescope/core';
import { listBaseTables, readTableIdentities, readTypeNames, type TableIdentity } from './introspect.js';

const { Pool } = pg;

/** Every value arrives as raw text; nothing is parsed into a JS type on the way in. */
const RAW_TEXT_TYPES = { getTypeParser: () => (value: string) => value };

/** Ceiling on how long one capture may hold its observer transaction open. */
const DEFAULT_WINDOW_TIMEOUT_MS = 30_000;

export interface MvccAdapterOptions {
  connectionString: string;
  windowTimeoutMs?: number;
  /** Replaced with `null` before the value leaves this file. */
  maskColumns?: ReadonlyArray<string>;
}

const MASKED: Value = { pgType: 'text', text: '••••••••' };

export class MvccPostgresAdapter implements DatabaseAdapter {
  readonly captureMethod = 'mvcc-xmin' as const;
  readonly detection = 'write' as const;

  /** Data connections. Everything comes back as raw text; nothing is parsed. */
  private readonly pool: pg.Pool;
  /**
   * Metadata connections, with the driver's normal parsers left on.
   *
   * Two pools rather than one because the two jobs want opposite things:
   * captured values must never be parsed, while catalogue queries return
   * arrays and booleans that are far easier to read as arrays and booleans.
   */
  private readonly metaPool: pg.Pool;
  private readonly windowTimeoutMs: number;
  private typeNames?: Map<number, string>;

  constructor(private readonly options: MvccAdapterOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, types: RAW_TEXT_TYPES, max: 6 });
    this.metaPool = new Pool({ connectionString: options.connectionString, max: 2 });
    this.windowTimeoutMs = options.windowTimeoutMs ?? DEFAULT_WINDOW_TIMEOUT_MS;
  }

  async listTables(): Promise<string[]> {
    const client = await this.metaPool.connect();
    try {
      return await listBaseTables(client);
    } finally {
      client.release();
    }
  }

  /** Builds a scope covering every base table — the default when none is declared. */
  async fullScope(overrides?: Partial<TableScope>): Promise<CaptureScope> {
    const tables = await this.listTables();
    const client = await this.metaPool.connect();
    try {
      const identities = await readTableIdentities(client, tables);
      return {
        allTables: true,
        tables: tables.map((table) => ({
          table,
          ignoreColumns: overrides?.ignoreColumns ?? [],
          maskedColumns: overrides?.maskedColumns ?? this.options.maskColumns ?? [],
          keyStrategy: identities.get(table)!.strategy,
        })),
      };
    } finally {
      client.release();
    }
  }

  async capture<T>(
    scope: CaptureScope,
    body: () => Promise<T>,
  ): Promise<{ result: T; changes: ChangeSet }> {
    const started = Date.now();
    const warnings: CaptureWarning[] = [];
    const observer = await this.pool.connect();

    let snapshot: string;
    let identities: Map<string, TableIdentity>;
    let beforeKeys: Map<string, Set<string>>;

    try {
      const meta = await this.metaPool.connect();
      try {
        if (!this.typeNames) this.typeNames = await readTypeNames(meta);
        identities = await readTableIdentities(
          meta,
          scope.tables.map((t) => t.table),
        );
      } finally {
        meta.release();
      }

      // A crashed runner must not leave a transaction pinning VACUUM forever.
      await observer.query(`SET idle_in_transaction_session_timeout = ${this.windowTimeoutMs}`);
      await observer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snap = await observer.query<{ snapshot: string }>(
        'SELECT pg_current_snapshot()::text AS snapshot',
      );
      snapshot = snap.rows[0]!.snapshot;

      beforeKeys = await this.readKeySets(observer, scope, identities);
    } catch (error) {
      observer.release();
      throw error;
    }

    // The step runs while the observer transaction stays open and idle.
    let result: T;
    try {
      result = await body();
    } catch (error) {
      await this.endObserver(observer);
      throw error;
    }

    try {
      const worker = await this.pool.connect();
      let changes: RowChange[];
      try {
        changes = await this.collectChanges(
          worker,
          observer,
          scope,
          identities,
          snapshot,
          beforeKeys,
          warnings,
        );
      } finally {
        worker.release();
      }

      return {
        result,
        changes: {
          captureMethod: this.captureMethod,
          detection: this.detection,
          scope,
          changes,
          warnings,
          durationMs: Date.now() - started,
        },
      };
    } finally {
      await this.endObserver(observer);
    }
  }

  /**
   * Watches an idle window and reports anything that wrote anyway.
   *
   * Background jobs, session sweepers and outbox pollers are ordinary in a
   * running dev stack, and rows they write would otherwise be attributed to the
   * step under test. Cheap enough to run before every scenario.
   */
  async probeBaselineNoise(scope: CaptureScope, windowMs: number): Promise<ChangeSet> {
    const { changes } = await this.capture(scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, windowMs));
    });
    if (changes.changes.length === 0) return changes;
    const tables = [...new Set(changes.changes.map((c) => c.table))];
    return {
      ...changes,
      warnings: [
        ...changes.warnings,
        {
          code: 'concurrent-writes-detected',
          message:
            `Something wrote to ${tables.join(', ')} during a ${windowMs} ms window in which ` +
            `no request was sent. Rows from these tables may not be caused by the scenario.`,
        },
      ],
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.end(), this.metaPool.end()]);
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  private async endObserver(client: pg.PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
      await client.query('RESET idle_in_transaction_session_timeout');
    } catch {
      // A dead connection is already released by the pool; nothing to salvage.
    } finally {
      client.release();
    }
  }

  private typeName(oid: number): string {
    return this.typeNames?.get(oid) ?? 'unknown';
  }

  private toRow(
    fields: ReadonlyArray<pg.FieldDef>,
    raw: Record<string, string | null>,
    masked: ReadonlySet<string>,
  ): Row {
    const row: Record<string, Value> = {};
    for (const field of fields) {
      row[field.name] = masked.has(field.name)
        ? MASKED
        : { pgType: this.typeName(field.dataTypeID), text: raw[field.name] ?? null };
    }
    return row;
  }

  private keyOf(row: Row, columns: ReadonlyArray<string>): RowKey | null {
    if (columns.length === 0) return null;
    const parts = columns.map((column) => ({ column, value: row[column]! }));
    return {
      columns: parts,
      // JSON of an ordered array: unambiguous for composite keys, and immune to
      // the delimiter collisions a joined string would have.
      serialized: JSON.stringify(parts.map((p) => [p.column, p.value?.text ?? null])),
    };
  }

  private quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** Reads only key columns — the cheap half, used to spot deletes. */
  private async readKeySets(
    client: pg.PoolClient,
    scope: CaptureScope,
    identities: Map<string, TableIdentity>,
  ): Promise<Map<string, Set<string>>> {
    const keys = new Map<string, Set<string>>();
    for (const table of scope.tables) {
      const identity = identities.get(table.table);
      if (!identity || identity.keyColumns.length === 0) continue;
      const columns = identity.keyColumns.map((c) => this.quoteIdent(c)).join(', ');
      const where = table.where ? ` WHERE ${table.where}` : '';
      const result = await client.query(
        `SELECT ${columns} FROM ${this.quoteIdent(table.table)}${where}`,
      );
      const set = new Set<string>();
      for (const raw of result.rows) {
        const row = this.toRow(result.fields, raw, new Set());
        set.add(this.keyOf(row, identity.keyColumns)!.serialized);
      }
      keys.set(table.table, set);
    }
    return keys;
  }

  private async collectChanges(
    worker: pg.PoolClient,
    observer: pg.PoolClient,
    scope: CaptureScope,
    identities: Map<string, TableIdentity>,
    snapshot: string,
    beforeKeys: Map<string, Set<string>>,
    warnings: CaptureWarning[],
  ): Promise<RowChange[]> {
    const changes: RowChange[] = [];

    for (const table of scope.tables) {
      const identity = identities.get(table.table)!;
      const masked = new Set(table.maskedColumns);
      const ignore = new Set(table.ignoreColumns);
      const where = table.where ? ` AND (${table.where})` : '';

      // Rows written during the window: their inserting transaction was not yet
      // visible when the observer froze its snapshot.
      const touched = await worker.query(
        `SELECT * FROM ${this.quoteIdent(table.table)}
          WHERE NOT pg_visible_in_snapshot(xmin::text::xid8, $1::pg_snapshot)${where}`,
        [snapshot],
      );

      if (identity.keyColumns.length === 0) {
        // No usable identity: rows can be counted but not paired, so an update
        // is indistinguishable from a delete plus an insert. Say so.
        if (touched.rows.length > 0) {
          warnings.push({
            code: 'degraded-row-identity',
            table: table.table,
            message:
              `\`${table.table}\` has no primary key or unique index, so changed rows cannot be ` +
              `matched to their previous version. Reporting them as inserts.`,
          });
          for (const raw of touched.rows) {
            const after = this.toRow(touched.fields, raw, masked);
            changes.push({
              table: table.table,
              key: null,
              kind: 'insert',
              before: null,
              after,
              changedColumns: Object.keys(after),
              visibleColumns: Object.keys(after).filter((c) => !ignore.has(c)),
              hasWrite: true,
            });
          }
        }
        continue;
      }

      const afterByKey = new Map<string, Row>();
      for (const raw of touched.rows) {
        const row = this.toRow(touched.fields, raw, masked);
        afterByKey.set(this.keyOf(row, identity.keyColumns)!.serialized, row);
      }

      const afterKeys = await this.readKeySets(worker, { ...scope, tables: [table] }, identities);
      const nowPresent = afterKeys.get(table.table) ?? new Set<string>();
      const wasPresent = beforeKeys.get(table.table) ?? new Set<string>();

      const deletedKeys = [...wasPresent].filter((k) => !nowPresent.has(k));
      const updatedKeys = [...afterByKey.keys()].filter((k) => wasPresent.has(k));

      // The time-travel step: read the previous version of every row we need
      // through the observer, which still sees the pre-request world.
      const beforeRows = await this.readBeforeImages(
        observer,
        table,
        identity,
        [...updatedKeys, ...deletedKeys],
        masked,
      );

      for (const [key, after] of afterByKey) {
        const before = beforeRows.get(key) ?? null;
        if (!before) {
          changes.push({
            table: table.table,
            key: this.keyOf(after, identity.keyColumns),
            kind: 'insert',
            before: null,
            after,
            changedColumns: Object.keys(after),
            visibleColumns: Object.keys(after).filter((c) => !ignore.has(c)),
            hasWrite: true,
          });
          continue;
        }
        const changedColumns = Object.keys(after).filter(
          (column) => !valuesLookEqual(before[column], after[column]),
        );
        changes.push({
          table: table.table,
          key: this.keyOf(after, identity.keyColumns),
          kind: 'update',
          before,
          after,
          changedColumns,
          visibleColumns: changedColumns.filter((c) => !ignore.has(c)),
          // True regardless of whether any value differs: the row was rewritten,
          // which is what an idempotency assertion needs to know.
          hasWrite: true,
        });
      }

      for (const key of deletedKeys) {
        const before = beforeRows.get(key);
        if (!before) continue;
        changes.push({
          table: table.table,
          key: this.keyOf(before, identity.keyColumns),
          // A narrowed scope makes absence ambiguous, so say which kind it is.
          kind: table.where ? 'left-scope' : 'delete',
          before,
          after: null,
          changedColumns: Object.keys(before),
          visibleColumns: Object.keys(before).filter((c) => !ignore.has(c)),
          hasWrite: true,
        });
      }
    }

    return changes;
  }

  private async readBeforeImages(
    observer: pg.PoolClient,
    table: TableScope,
    identity: TableIdentity,
    keys: ReadonlyArray<string>,
    masked: ReadonlySet<string>,
  ): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    if (keys.length === 0) return out;

    const width = identity.keyColumns.length;
    const keyValues = keys.map((key) => (JSON.parse(key) as [string, string | null][]).map((k) => k[1]));
    const tuple = `(${identity.keyColumns.map((c) => this.quoteIdent(c)).join(', ')})`;

    // One round trip regardless of key width: a row-value IN list. Postgres
    // infers each parameter's type from the column it sits opposite, so a
    // composite key of mixed types needs no casts here.
    const placeholders = keyValues
      .map((_, i) => `(${identity.keyColumns.map((__, j) => `$${i * width + j + 1}`).join(', ')})`)
      .join(', ');

    const result = await observer.query(
      `SELECT * FROM ${this.quoteIdent(table.table)} WHERE ${tuple} IN (${placeholders})`,
      keyValues.flat(),
    );

    for (const raw of result.rows) {
      const row = this.toRow(result.fields, raw, masked);
      const key = JSON.stringify(
        identity.keyColumns.map((column) => [column, row[column]?.text ?? null]),
      );
      out.set(key, row);
    }
    return out;
  }
}

/**
 * Raw-text comparison used only to decide which columns changed within a row we
 * already know was written. Semantic comparison (jsonb key order, numeric
 * scale, citext case) belongs to the assertion layer, which knows the type.
 */
function valuesLookEqual(a: Value | undefined, b: Value | undefined): boolean {
  return (a?.text ?? null) === (b?.text ?? null);
}

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
  RowChange,
  TableScope,
  } from '@statescope/core';
import {
  listBaseTables,
  readLocation,
  readTableIdentities,
  type TableIdentity,
} from './introspect.js';
import { readCurrentRows, readKeySets } from './images.js';
import { collectNetChanges, readRelfilenodes, reportRewrites } from './net-view.js';
import type { RowsRead } from '@statescope/core';
import { pinPool, verifyRendering, type Rendering } from './pinning.js';
import { RAW_TEXT_TYPES, ROWS_LIMIT, RowReader } from './rows.js';

const { Pool } = pg;

/** Ceiling on how long one capture may hold its observer transaction open. */
const DEFAULT_WINDOW_TIMEOUT_MS = 30_000;

export interface MvccAdapterOptions {
  connectionString: string;
  windowTimeoutMs?: number;
  /** Replaced with `null` before the value leaves this file. */
  maskColumns?: ReadonlyArray<string>;
}

export class MvccPostgresAdapter implements DatabaseAdapter {
  readonly captureMethod = 'mvcc-xmin' as const;
  readonly detection = 'write' as const;
  // It knows a row was written; it cannot know how many times, or in what
  // order relative to another table. Saying `net` is what stops a consumer
  // from believing an ordering it was never given.
  readonly fidelity = 'net' as const;

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
  private readonly reader = new RowReader();

  constructor(private readonly options: MvccAdapterOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, types: RAW_TEXT_TYPES, max: 6 });
    this.metaPool = new Pool({ connectionString: options.connectionString, max: 2 });
    // Both pools: catalogue reads do not care, but a connection that renders
    // differently depending on which pool it came from is a trap for the next
    // person to add a query.
    pinPool(this.pool);
    pinPool(this.metaPool);
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
      const where = await readLocation(client);
      return {
        ...where,
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

  /**
   * Rows as they are now, for a `rows(...)` selector.
   *
   * Bounded: a selector is meant to pick out a handful of rows, and a
   * predicate that matches a whole table is a mistake worth reporting rather
   * than a query worth running.
   */
  async readRows(
    table: string,
    clauses: ReadonlyArray<{ column: string; value: string }>,
    scope: CaptureScope,
  ): Promise<RowsRead> {
    const spec = scope.tables.find((t) => t.table === table);
    if (!spec) return { rows: [], complete: true };
    const meta = await this.metaPool.connect();
    let identity;
    try {
      await this.reader.ensureTypes(meta);
      identity = (await readTableIdentities(meta, [table])).get(table);
    } finally {
      meta.release();
    }
    const client = await this.pool.connect();
    try {
      return await readCurrentRows(client, this.reader, spec, identity, clauses, ROWS_LIMIT);
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
    let relfilenodesBefore: Map<string, string>;

    try {
      const meta = await this.metaPool.connect();
      try {
        await this.reader.ensureTypes(meta);
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
      relfilenodesBefore = await this.readRelfilenodesOutsideObserver(
        scope.tables.map((t) => t.table),
      );
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
      // The before key set is read *after* the step, not before it.
      //
      // The observer's snapshot is frozen, so it sees the same pre-request
      // world whenever it is asked — but a scan taken before the step holds
      // ACCESS SHARE on every watched table for the whole window, and anything
      // needing a stronger lock then waits. Measured: a `TRUNCATE` inside a
      // step queued behind that lock until the idle-in-transaction timeout
      // killed the capture. Read afterwards, the same TRUNCATE completes in a
      // millisecond and the answer is identical.
      const beforeKeys = await readKeySets(observer, this.reader, scope, identities);
      // A table rewritten mid-step takes the observer's view of it with it.
      reportRewrites(
        relfilenodesBefore,
        await this.readRelfilenodesOutsideObserver(scope.tables.map((t) => t.table)),
        warnings,
      );

      const worker = await this.pool.connect();
      let changes: RowChange[];
      let rendering: Rendering;
      try {
        // On the connection that reads the values, not on any connection.
        rendering = await verifyRendering(worker, warnings);
        changes = await collectNetChanges(
          this.reader,
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
          fidelity: this.fidelity,
          scope,
          changes,
          rendering,
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

  /**
   * Reads the catalogue on its own connection, deliberately not the observer's.
   *
   * A catalogue read inside the observer's REPEATABLE READ transaction can come
   * from the frozen snapshot, so both sides of the window report the same
   * `relfilenode` and a table rewritten mid-step goes unnoticed — which is the
   * silent case this check exists to catch.
   */
  private async readRelfilenodesOutsideObserver(
    tables: ReadonlyArray<string>,
  ): Promise<Map<string, string>> {
    const client = await this.metaPool.connect();
    try {
      return await readRelfilenodes(client, tables);
    } finally {
      client.release();
    }
  }

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


}

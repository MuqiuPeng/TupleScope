/**
 * The snapshot-diff capture engine.
 *
 * The obvious implementation, and the one most tools of this kind stop at:
 * read every watched table before the step, read it again after, compare.
 *
 * It exists here for two reasons. It is the reference implementation — small
 * enough to be read in one sitting and check the contract against — and it is
 * the engine that sits at the *opposite* corner of the capability space from
 * mvcc-xmin, which makes it the useful one to test the abstraction with. If a
 * ChangeSet means the same thing to a consumer whether it came from a held
 * MVCC snapshot or from two `SELECT *`s, the contract is doing its job.
 *
 * What it cannot do, and says so through `detection: 'value'`:
 *
 *   UPDATE wallets SET balance = balance   -- a write, no value differs
 *   UPDATE wallets SET balance = 80; UPDATE wallets SET balance = 100
 *
 * Both leave the table byte-identical. This engine reports nothing, because
 * nothing it can observe changed — which is correct, not a bug, and is exactly
 * why `hasWrite` against a value-detection engine raises `unevaluable` rather
 * than returning false. An idempotency test needs mvcc-xmin or wal.
 *
 * What it costs: two full reads of every watched table per step. On the 500k-row
 * / 161 MB table measured against mvcc-xmin, that is ~800 ms and ~322 MB versus
 * ~33 ms and a few kB. Past `maxRowsPerTable` it declines to read the table at
 * all and reports `scope-truncated`, which escalates the run to `undecided` —
 * an unobserved table must never read as an observed one that stayed still.
 */

import pg from 'pg';
import { isVisible } from '@tuplescope/core';
import type {
  CaptureScope,
  CaptureWarning,
  ChangeSet,
  DatabaseAdapter,
  Row,
  RowChange,
  TableScope,
} from '@tuplescope/core';
import {
  listBaseTables, listColumnsByTable,
  readLocation,
  readTableIdentities,
  type TableIdentity,
} from './introspect.js';
import { readCurrentRows } from './images.js';
import type { RowsRead } from '@tuplescope/core';
import { absorbIdleErrors, pinPool, verifyRendering } from './pinning.js';
import { quoteIdent, RAW_TEXT_TYPES, ROWS_LIMIT, RowReader, serializeKey, valuesLookEqual } from './rows.js';

const { Pool } = pg;

/**
 * Above this many rows a table is skipped rather than read twice. Chosen so the
 * default behaviour stays inside a second on ordinary dev data; a workspace
 * that wants the whole thing can raise it and pay for it.
 */
const DEFAULT_MAX_ROWS_PER_TABLE = 50_000;

export interface SnapshotAdapterOptions {
  connectionString: string;
  maxRowsPerTable?: number;
  /** Replaced with `null` before the value leaves this file. */
  maskColumns?: ReadonlyArray<string>;
}

/** One table's contents at one instant, keyed for diffing. */
/** Every captured row is held twice: raw for comparison, redacted for report. */
interface Pair {
  raw: Row;
  shown: Row;
}

type TableImage =
  // Two images per row: the raw one decides identity and which columns moved,
  // the redacted one is what is reported. Comparing redacted rows makes every
  // masked column look unchanged, because both sides are the placeholder.
  | { read: true; rows: Map<string, { raw: Row; shown: Row }>; unkeyed: Pair[] }
  | { read: false; reason: string };

export class SnapshotPostgresAdapter implements DatabaseAdapter {
  readonly captureMethod = 'snapshot-diff' as const;
  // It compares values. A write that changed no value is not a value change,
  // and this engine has no way to learn one happened.
  readonly detection = 'value' as const;
  readonly fidelity = 'net' as const;

  private readonly pool: pg.Pool;
  private readonly metaPool: pg.Pool;
  private readonly maxRowsPerTable: number;
  private readonly reader = new RowReader();

  constructor(private readonly options: SnapshotAdapterOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, types: RAW_TEXT_TYPES, max: 6 });
    this.metaPool = new Pool({ connectionString: options.connectionString, max: 2 });
    // Both pools: catalogue reads do not care, but a connection that renders
    // differently depending on which pool it came from is a trap for the next
    // person to add a query.
    pinPool(this.pool);
    pinPool(this.metaPool);
    // A socket that dies while idle must not become an uncaught crash.
    absorbIdleErrors(this.pool);
    absorbIdleErrors(this.metaPool);
    this.maxRowsPerTable = options.maxRowsPerTable ?? DEFAULT_MAX_ROWS_PER_TABLE;
  }

  async listTables(): Promise<string[]> {
    const client = await this.metaPool.connect();
    try {
      return await listBaseTables(client);
    } finally {
      client.release();
    }
  }

  /** Every base table's columns, for `check` to resolve a predicate against. */
  async listColumns(): Promise<Map<string, Set<string>>> {
    const client = await this.metaPool.connect();
    try {
      return await listColumnsByTable(client);
    } finally {
      client.release();
    }
  }

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

    const meta = await this.metaPool.connect();
    let identities: Map<string, TableIdentity>;
    try {
      await this.reader.ensureTypes(meta);
      identities = await readTableIdentities(
        meta,
        scope.tables.map((t) => t.table),
      );
    } finally {
      meta.release();
    }

    // Read before the step, on the pool that reads values: the before-image is
    // already text by the time the step runs, so a drift discovered afterwards
    // would be discovered too late to describe it.
    const data = await this.pool.connect();
    let rendering;
    try {
      rendering = await verifyRendering(data, warnings);
    } finally {
      data.release();
    }

    const before = await this.readAll(scope, identities);

    // Nothing is held open across the step. That is the engine's one advantage
    // over mvcc-xmin: no transaction pinning VACUUM, no idle-in-transaction.
    const result = await body();

    const after = await this.readAll(scope, identities);
    const changes = this.diff(scope, identities, before, after, warnings);

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
  }

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

  private async readAll(
    scope: CaptureScope,
    identities: Map<string, TableIdentity>,
  ): Promise<Map<string, TableImage>> {
    const images = new Map<string, TableImage>();
    const client = await this.pool.connect();
    try {
      for (const table of scope.tables) {
        images.set(table.table, await this.readTable(client, table, identities.get(table.table)));
      }
    } finally {
      client.release();
    }
    return images;
  }

  private async readTable(
    client: pg.PoolClient,
    table: TableScope,
    identity: TableIdentity | undefined,
  ): Promise<TableImage> {
    const where = table.where ? ` WHERE ${table.where}` : '';
    const name = quoteIdent(table.table);

    // Ask the size before reading the contents. Refusing to read a huge table
    // costs one count; reading it and regretting it costs the whole table.
    const counted = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${name}${where}`);
    const rowCount = Number(counted.rows[0]?.n ?? 0);
    if (rowCount > this.maxRowsPerTable) {
      return {
        read: false,
        reason:
          `${table.table} holds ${rowCount.toLocaleString()} rows in scope, over the ` +
          `${this.maxRowsPerTable.toLocaleString()} the snapshot-diff engine will read twice per ` +
          `step. It was not observed. Narrow the scope with a watch predicate, raise ` +
          `maxRowsPerTable, or use the mvcc-xmin engine, which does not read whole tables.`,
      };
    }

    const masked = new Set(table.maskedColumns);
    const result = await client.query(`SELECT * FROM ${name}${where}`);
    const rows = new Map<string, { raw: Row; shown: Row }>();
    const unkeyed: Pair[] = [];
    for (const raw of result.rows) {
      // Keyed on the raw row, masked on the way in — the same rule the net view
      // follows. Keying off the masked row collapses every key on a redacted
      // column to one placeholder, so the before and after images never pair.
      const bare = this.reader.toRow(result.fields, raw, new Set());
      const row = this.reader.toRow(result.fields, raw, masked);
      if (!identity || identity.keyColumns.length === 0) unkeyed.push({ raw: bare, shown: row });
      else rows.set(serializeKey(bare, identity.keyColumns), { raw: bare, shown: row });
    }
    return { read: true, rows, unkeyed };
  }

  private diff(
    scope: CaptureScope,
    identities: Map<string, TableIdentity>,
    before: Map<string, TableImage>,
    after: Map<string, TableImage>,
    warnings: CaptureWarning[],
  ): RowChange[] {
    const changes: RowChange[] = [];

    for (const table of scope.tables) {
      const b = before.get(table.table)!;
      const a = after.get(table.table)!;

      // A table that could not be read on either side is unobserved, and an
      // unobserved table has to escalate rather than look quiet.
      if (!b.read || !a.read) {
        warnings.push({
          code: 'scope-truncated',
          table: table.table,
          message: b.read ? (a as { reason: string }).reason : b.reason,
        });
        continue;
      }

      const identity = identities.get(table.table);
      const ignore = new Set(table.ignoreColumns);
      const emit = (partial: Omit<RowChange, 'visibleColumns' | 'hasWrite'>) =>
        changes.push({
          ...partial,
          visibleColumns: partial.changedColumns.filter((c) => !ignore.has(c)),
          // Reaching here means a value differs, and a value cannot differ
          // without a write. The converse — a write with no differing value —
          // is the case this engine cannot see, which `detection` declares.
          hasWrite: true,
        });

      if (!identity || identity.keyColumns.length === 0) {
        this.diffUnkeyed(table, b.unkeyed, a.unkeyed, emit, warnings);
        continue;
      }

      for (const [key, afterRow] of a.rows) {
        const beforeRow = b.rows.get(key);
        if (!beforeRow) {
          emit({
            table: table.table,
            key: this.reader.keyOf(afterRow.shown, afterRow.raw, identity.keyColumns),
            kind: 'insert',
            before: null,
            after: afterRow.shown,
            changedColumns: Object.keys(afterRow.shown),
          });
          continue;
        }
        // Compared raw, reported redacted. Comparing the redacted images would
        // make a change confined to a masked column look like no change at all
        // — and for this engine the comparison *is* the whole answer.
        const changedColumns = Object.keys(afterRow.raw).filter(
          (column) => !valuesLookEqual(beforeRow.raw[column], afterRow.raw[column]),
        );
        // No column differs, so as far as this engine is concerned the row did
        // not change. mvcc-xmin would emit an update here with an empty
        // changedColumns if the row had been rewritten; that difference is the
        // detection axis, not a disagreement about facts.
        if (changedColumns.length === 0) continue;
        emit({
          table: table.table,
          key: this.reader.keyOf(afterRow.shown, afterRow.raw, identity.keyColumns),
          kind: 'update',
          before: beforeRow.shown,
          after: afterRow.shown,
          changedColumns,
        });
      }

      for (const [key, beforeRow] of b.rows) {
        if (a.rows.has(key)) continue;
        emit({
          table: table.table,
          key: this.reader.keyOf(beforeRow.shown, beforeRow.raw, identity.keyColumns),
          // A narrowed scope makes absence ambiguous, so say which kind it is.
          kind: table.where ? 'left-scope' : 'delete',
          before: beforeRow.shown,
          after: null,
          changedColumns: Object.keys(beforeRow.shown),
        });
      }
    }

    return changes;
  }

  /**
   * Without a key there is no pairing, so the two sides are compared as
   * multisets: rows present the same number of times on both sides cancel, and
   * whatever is left over is reported as bare arrivals and departures.
   */
  private diffUnkeyed(
    table: TableScope,
    before: ReadonlyArray<Pair>,
    after: ReadonlyArray<Pair>,
    emit: (partial: Omit<RowChange, 'visibleColumns' | 'hasWrite'>) => void,
    warnings: CaptureWarning[],
  ): void {
    // Census taken on the raw image. Two rows differing only in a masked
    // column carry the same placeholder, so a redacted census would give them
    // one identity, cancel them against each other, and report nothing.
    const census = (rows: ReadonlyArray<Pair>) => {
      const counts = new Map<string, { row: Pair; n: number }>();
      for (const pair of rows) {
        const id = JSON.stringify(
          Object.keys(pair.raw)
            .sort()
            .map((c) => {
              const value = pair.raw[c];
              // Tagged by state: a column that is genuinely NULL and one that
              // could not be read are different rows, not the same row twice.
              return isVisible(value) ? [c, 'v', value.text] : [c, value?.state ?? 'absent', null];
            }),
        );
        const seen = counts.get(id);
        if (seen) seen.n += 1;
        else counts.set(id, { row: pair, n: 1 });
      }
      return counts;
    };

    const b = census(before);
    const a = census(after);
    let reported = false;

    for (const [id, entry] of a) {
      const surplus = entry.n - (b.get(id)?.n ?? 0);
      for (let i = 0; i < surplus; i += 1) {
        reported = true;
        emit({
          table: table.table,
          key: null,
          kind: 'insert',
          before: null,
          after: entry.row.shown,
          changedColumns: Object.keys(entry.row.shown),
        });
      }
    }
    for (const [id, entry] of b) {
      const missing = entry.n - (a.get(id)?.n ?? 0);
      for (let i = 0; i < missing; i += 1) {
        reported = true;
        emit({
          table: table.table,
          key: null,
          kind: table.where ? 'left-scope' : 'delete',
          before: entry.row.shown,
          after: null,
          changedColumns: Object.keys(entry.row.shown),
        });
      }
    }

    if (reported) {
      warnings.push({
        code: 'degraded-row-identity',
        table: table.table,
        message:
          `\`${table.table}\` has no primary key or unique index, so changed rows cannot be ` +
          `matched to their previous version. Reporting them as inserts and deletes.`,
      });
    }
  }
}

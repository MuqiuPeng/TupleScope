/**
 * The wal capture engine: logical decoding for detection, MVCC for values.
 *
 * It reads the write-ahead log to learn *which rows were written, in what
 * order, by which transaction*, and then reads the actual column values the
 * same way mvcc-xmin does — after-images with an ordinary SELECT, before-images
 * out of a still-open REPEATABLE READ transaction.
 *
 * The split is not a compromise; it is what measurement forced. Against
 * PostgreSQL 17.5, the values in the decoded stream are wrong for this purpose
 * in four separate ways:
 *
 *   boolean   `SELECT` returns `f`, the decoder writes `false`
 *   types     the decoder writes format names — `integer`, `boolean`,
 *             `timestamp with time zone` — where `pg_type.typname` has
 *             `int4`, `bool`, `timestamptz`
 *   TOAST     a large column an UPDATE did not touch arrives as the literal
 *             `unchanged-toast-datum`, so the after-image is simply incomplete
 *   identity  under the default REPLICA IDENTITY an UPDATE carries no old row
 *             at all and a DELETE carries only its key, so there is no
 *             before-image to be had without `REPLICA IDENTITY FULL` — a DDL
 *             change to the user's own tables, which this tool will not make
 *
 * Taking values from SQL makes all four disappear, and makes this engine's
 * output byte-identical to mvcc-xmin's by construction rather than by luck.
 * What the WAL stream adds, and xmin cannot: the order writes happened in,
 * which transaction grouped them, and rows that were inserted and deleted
 * inside one transaction — which leave no row version for xmin to find.
 *
 * Requires `wal_level = logical`, which is a server restart. The engine checks
 * and refuses clearly rather than reporting a quiet database.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type {
  CaptureScope,
  CaptureWarning,
  ChangeSet,
  DatabaseAdapter,
  RowChange,
  Mutation,
  RowKey,
  TableScope,
  Value,
} from '@tuplescope/core';
import { decodeStream, toWireText, type DecodedChange } from './decode.js';
import { readCurrentRows, readKeySets } from './images.js';
import { masked as maskedValue, visible } from '@tuplescope/core';
import type { RowsRead } from '@tuplescope/core';
import { absorbIdleErrors, pinPool, verifyRendering, type Rendering } from './pinning.js';
import { collectNetChanges, readRelfilenodes, reportRewrites } from './net-view.js';
import {
  describeScope, listBaseTables, listColumnsByTable,
  readLocation,
  readTableIdentities,
  type ScopeReport,
  type TableIdentity,
} from './introspect.js';
import { RAW_TEXT_TYPES, RowReader, ROWS_LIMIT } from './rows.js';

const { Pool } = pg;

const DEFAULT_WINDOW_TIMEOUT_MS = 30_000;

/**
 * How long to wait for WAL to reach disk before decoding.
 *
 * Not a formality. On a database with `synchronous_commit = off` — the common
 * setting on a developer machine, because it is faster — a committed write is
 * *invisible* to logical decoding until the WAL writer flushes it, which is one
 * `wal_writer_delay` away (200 ms by default). Measured: without this wait the
 * engine reports zero changes for a step that wrote four rows, and then reports
 * those rows as part of the *next* step. Silently attributing one request's
 * writes to another is worse than missing them.
 */
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

export interface WalAdapterOptions {
  connectionString: string;
  windowTimeoutMs?: number;
  flushTimeoutMs?: number;
  /** Replaced with `null` before the value leaves this file. */
  maskColumns?: ReadonlyArray<string>;
}

export class WalPostgresAdapter implements DatabaseAdapter {
  readonly captureMethod = 'wal' as const;
  readonly detection = 'write' as const;
  readonly fidelity = 'transactional' as const;

  private readonly pool: pg.Pool;
  private readonly metaPool: pg.Pool;
  private readonly windowTimeoutMs: number;
  private readonly flushTimeoutMs: number;
  private readonly reader = new RowReader();
  private slotSequence = 0;

  constructor(private readonly options: WalAdapterOptions) {
    this.pool = new Pool({ connectionString: options.connectionString, types: RAW_TEXT_TYPES, max: 6 });
    // One connection is held for the whole of each capture by the slot.
    this.metaPool = new Pool({ connectionString: options.connectionString, max: 4 });
    // Both pools: catalogue reads do not care, but a connection that renders
    // differently depending on which pool it came from is a trap for the next
    // person to add a query.
    pinPool(this.pool);
    pinPool(this.metaPool);
    // A socket that dies while idle must not become an uncaught crash.
    absorbIdleErrors(this.pool);
    absorbIdleErrors(this.metaPool);
    this.windowTimeoutMs = options.windowTimeoutMs ?? DEFAULT_WINDOW_TIMEOUT_MS;
    this.flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
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

  /** What is watched, and what is not. Reported so a gap can never be silent. */
  async describeScope(): Promise<ScopeReport> {
    const client = await this.metaPool.connect();
    try {
      return await describeScope(client);
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
   * Fails loudly if the server cannot do logical decoding, naming the setting
   * and the fact that it needs a restart. The alternative — creating a slot
   * that errors, or worse, decoding an empty stream — would look like a
   * database where nothing happened.
   */
  async preflight(): Promise<void> {
    const client = await this.metaPool.connect();
    try {
      const level = (await client.query<{ wal_level: string }>('SHOW wal_level')).rows[0]!.wal_level;
      if (level !== 'logical') {
        throw new Error(
          `The wal engine needs \`wal_level = logical\`; this server has \`${level}\`. ` +
            `Set it in postgresql.conf and restart PostgreSQL — it cannot be changed at runtime. ` +
            `The mvcc-xmin engine needs no server configuration and detects writes just as well; ` +
            `it only cannot tell you the order they happened in.`,
        );
      }
      // Creating a slot is superuser-or-REPLICATION, checked in C: no GRANT
      // makes it work, so the message has to say which role attribute is
      // missing rather than let the user hunt for a permission to add.
      const role = await client.query<{ ok: boolean }>(
        `SELECT rolsuper OR rolreplication AS ok FROM pg_roles WHERE rolname = current_user`,
      );
      if (!role.rows[0]?.ok) {
        throw new Error(
          `The wal engine creates a logical replication slot, which needs the connecting role to ` +
            `be a superuser or to have the REPLICATION attribute; the connecting role has neither. ` +
            `\`ALTER ROLE ... WITH REPLICATION\` grants it. On a managed database the equivalent ` +
            `is usually a provider-specific role — \`rds_replication\` on RDS — and may need a ` +
            `parameter change and a reboot.`,
        );
      }

      const slots = await client.query<{ used: string; max: string; stale: string[] }>(
        `SELECT (SELECT count(*) FROM pg_replication_slots) AS used,
                current_setting('max_replication_slots') AS max,
                (SELECT coalesce(array_agg(slot_name::text), '{}')
                   FROM pg_replication_slots
                  WHERE slot_name LIKE 'tuplescope\\_%' AND NOT active AND NOT temporary) AS stale`,
      );
      const { used, max, stale } = slots.rows[0]!;
      if (stale.length > 0) {
        // Every slot this engine makes is temporary, so one that outlived its
        // session cannot have come from a healthy run — and an unconsumed slot
        // pins WAL until the disk fills.
        throw new Error(
          `Replication slot(s) left behind by an earlier run: ${stale.join(', ')}. ` +
            `This engine only ever creates temporary slots, so these should not exist — an ` +
            `unconsumed slot holds WAL until the disk fills. Drop them with ` +
            `${stale.map((n) => `SELECT pg_drop_replication_slot('${n}');`).join(' ')}`,
        );
      }
      if (Number(used) >= Number(max)) {
        throw new Error(
          `All ${max} replication slots are in use, so this engine cannot create one. ` +
            `Check \`SELECT slot_name, active, wal_status FROM pg_replication_slots\` for slots ` +
            `left behind by something that died, and drop them with pg_drop_replication_slot().`,
        );
      }
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
    clauses: ReadonlyArray<{ column: string; value: string | null }>,
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

    const observer = await this.pool.connect();
    // The slot lives on its own connection and is temporary, so it is dropped
    // by the server the moment that connection goes — including when this
    // process is killed. A leaked logical slot pins WAL until the disk fills,
    // which is not a thing a test tool may risk on someone's machine.
    // Deliberately *not* `this.pool`: that pool disables every type parser so
    // captured values arrive as raw text, which also turns a boolean result
    // into the string `'t'`. The flush check below is a boolean, and `'t'` is
    // truthy — so on the raw pool the wait silently never waited, and on an
    // async-commit database the engine reported an empty stream.
    const slotConn = await this.metaPool.connect();
    // Random rather than the pid: two developers pointed at one shared server
    // would collide on `tuplescope_<pid>_0` and get a bare 42710 with nothing
    // to suggest another human caused it.
    const slot = `tuplescope_${randomBytes(6).toString('hex')}_${this.slotSequence++}`;

    let snapshot: string;
    let openedAt: string;
    let relfilenodesBefore: Map<string, string>;
    try {
      // The slot comes first, and the snapshot second, because the reverse
      // order loses writes.
      //
      // Whatever commits between the two is seen by exactly one of them. With
      // the snapshot first, such a transaction is missing from the log while
      // its rows are still found by the scan — the mutation list silently
      // undercounts, and `atomic()` answers `true` over a step that was not.
      // With the slot first the same transaction is in the log and already
      // inside the snapshot, so `openedAt` below can drop it exactly.
      await this.createSlot(slotConn, slot);
      await observer.query(`SET idle_in_transaction_session_timeout = ${this.windowTimeoutMs}`);
      await observer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const opened = await observer.query<{ snapshot: string; lsn: string }>(
        'SELECT pg_current_snapshot()::text AS snapshot, pg_current_wal_insert_lsn()::text AS lsn',
      );
      snapshot = opened.rows[0]!.snapshot;
      // The near edge of the window, in the log's own units. Anything that
      // committed before this is already in the observer's view of "before".
      openedAt = opened.rows[0]!.lsn;
      relfilenodesBefore = await this.readRelfilenodesOutsideObserver(
        scope.tables.map((t) => t.table),
      );
    } catch (error) {
      slotConn.release(true);
      await this.endObserver(observer);
      throw error;
    }

    let result: T;
    try {
      result = await body();
    } catch (error) {
      slotConn.release(true);
      await this.endObserver(observer);
      throw error;
    }

    try {
      const closedAt = await this.waitForFlush(slotConn, warnings);
      // Both edges fenced. `upto_lsn` stops decoding at the first commit past
      // the far edge, so a transaction that commits while this is being read is
      // not blamed on the step; `openedAt` below drops the ones that were
      // already inside the observer's "before".
      const raw = await slotConn.query<{ lsn: string; xid: string; data: string }>(
        `SELECT lsn::text AS lsn, xid::text AS xid, data
           FROM pg_logical_slot_get_changes($1, $2::pg_lsn, NULL)`,
        [slot, closedAt],
      ).catch((error: unknown) => {
        throw slotFailure(error, slot);
      });
      const decoded = decodeStream(withinWindow(raw.rows, openedAt));
      if (decoded.problems.length > 0) {
        warnings.push({
          code: 'reduced-fidelity',
          message:
            `${decoded.problems.length} line(s) of the decoded write-ahead log could not be read, so ` +
            `some writes may not be reported. First: ${decoded.problems[0]!.reason} — ` +
            `\`${decoded.problems[0]!.line}\``,
        });
      }

      // Read after the step, not before: a scan taken before it holds
      // ACCESS SHARE on every watched table for the whole window, and a
      // `TRUNCATE` inside the step then waits for the idle timeout to kill the
      // capture. The observer's snapshot is frozen, so the answer is the same.
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
        // On the connection that reads the values. It also decides how
        // `pg_logical_slot_get_changes` renders, since test_decoding prints
        // through the reading session's settings.
        rendering = await verifyRendering(worker, warnings);
        // The same net view mvcc-xmin computes, from the same code. Nothing
        // about *which rows changed* comes from the decoded log: that path
        // required matching decoder text against wire text, and a `bool` key
        // printing `true` where the wire says `t` was enough to report an
        // empty ChangeSet over a real write.
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
        crossCheck(changes, decoded.mutations, scope, warnings);
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
          // What declaring `transactional` actually commits to. Without it the
          // capability would be a claim nothing could check — an engine could
          // say `transactional` and be lying, and the conformance suite would
          // have no way to notice.
          mutations: toMutations(decoded.mutations, scope, identities, this.reader),
          warnings,
          durationMs: Date.now() - started,
        },
      };
    } finally {
      // Dropping the connection drops the temporary slot with it.
      slotConn.release(true);
      await this.endObserver(observer);
    }
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

  /**
   * Blocks until every WAL record written so far has been flushed, because
   * logical decoding cannot see further than the flush point.
   *
   * The high-water mark is taken once and then waited for, rather than polling
   * `insert <= flush`, so a database that is busy for other reasons still lets
   * this terminate. Costs nothing when `synchronous_commit` is on, and one
   * `wal_writer_delay` when it is off.
   *
   * Nothing is written to force the flush. A tool whose entire claim is that it
   * only observes must not start writing to the database to make its own
   * observation work.
   */
  private async waitForFlush(client: pg.PoolClient, warnings: CaptureWarning[]): Promise<string> {
    const mark = (await client.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn'))
      .rows[0]!.lsn;
    const deadline = Date.now() + this.flushTimeoutMs;
    for (;;) {
      // Cast to int rather than returning a boolean, so the answer means the
      // same thing whether or not the connection parses types.
      const caught = await client.query<{ ok: string }>(
        'SELECT (pg_current_wal_flush_lsn() >= $1::pg_lsn)::int AS ok',
        [mark],
      );
      if (Number(caught.rows[0]!.ok) === 1) return mark;
      if (Date.now() >= deadline) {
        warnings.push({
          code: 'scope-truncated',
          message:
            `The write-ahead log had not reached disk ${this.flushTimeoutMs} ms after the step ` +
            `finished, so writes committed near the end of it may be missing from this report. ` +
            `This usually means \`synchronous_commit\` is off and the server is under load.`,
        });
        return mark;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /**
   * Creates the temporary slot, translating the failures a person can act on.
   *
   * A bare driver error here is unhelpful in the two ways it most often fails:
   * a name collision means another TupleScope is running, and a slot that
   * vanishes between creation and use means a connection pooler moved the two
   * statements to different backends.
   */
  private async createSlot(client: pg.PoolClient, slot: string): Promise<void> {
    try {
      await client.query(`SELECT pg_create_logical_replication_slot($1, 'test_decoding', true)`, [slot]);
    } catch (error) {
      throw slotFailure(error, slot);
    }
  }

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

/**
 * Compares what the log saw against what the snapshot found, and says so when
 * they disagree.
 *
 * Two independent observations of the same window is a property worth spending:
 * the log names the tables that were written, and the xmin scan finds the rows.
 * If the log reports writes to a table the scan found nothing in, one of them
 * is wrong — most likely WAL that had not reached disk when it was read — and
 * the run must be marked as incomplete rather than quietly reported as quiet.
 *
 * The reverse direction is expected and not a discrepancy: the scan legitimately
 * finds rows the log does not name when a concurrent transaction committed
 * after the fence.
 */
function crossCheck(
  changes: ReadonlyArray<RowChange>,
  decoded: ReadonlyArray<DecodedChange>,
  scope: CaptureScope,
  warnings: CaptureWarning[],
): void {
  const watched = new Set(scope.tables.map((t) => t.table));
  const found = new Set(changes.map((c) => c.table));
  const missing = [
    ...new Set(
      decoded
        .filter((d) => watched.has(d.table) && d.operation !== 'truncate' && !found.has(d.table))
        .map((d) => d.table),
    ),
  ];
  if (missing.length === 0) return;
  warnings.push({
    code: 'reduced-fidelity',
    message:
      `The write-ahead log recorded writes to ${missing.join(', ')} that the row scan did not ` +
      `find. The two observations of this window disagree, so the reported changes may be ` +
      `incomplete — most often this means WAL had not reached disk when it was read.`,
  });
}

/**
 * Reshapes the decoded stream into the contract's `Mutation`, dropping the raw
 * column text: it exists here only to build a key, and is not to be trusted as
 * a value anywhere else.
 *
 * Writes to tables outside the scope are dropped, so the mutation list covers
 * exactly what the ChangeSet claims to have watched.
 */
function toMutations(
  decoded: ReadonlyArray<DecodedChange>,
  scope: CaptureScope,
  identities: Map<string, TableIdentity>,
  reader: RowReader,
): Mutation[] {
  const watched = new Set(scope.tables.map((t) => t.table));
  const out: Mutation[] = [];
  for (const change of decoded) {
    if (!watched.has(change.table)) continue;
    const identity = identities.get(change.table);
    const masked = new Set(scope.tables.find((t) => t.table === change.table)?.maskedColumns ?? []);
    out.push({
      // Renumbered over the kept subset, so the sequence has no gaps where an
      // unwatched table was skipped.
      sequence: out.length,
      transactionId: change.transactionId,
      table: change.table,
      operation: change.operation,
      key: identity ? mutationKey(change, identity, masked, reader) : null,
    });
  }
  return out;
}

/**
 * The key of the row a decoded record touched, in the text a `SELECT` would
 * return — so it lines up with the keys in `changes`.
 *
 * `null` when the decoder did not print every key column (a table whose
 * REPLICA IDENTITY hides them) or printed one it cannot recover (an unchanged
 * TOAST datum). Saying nothing is the honest answer; guessing produces a key
 * that matches no row and silently drops the write out of every question asked
 * about it.
 */
function mutationKey(
  change: DecodedChange,
  identity: TableIdentity,
  masked: ReadonlySet<string>,
  reader: RowReader,
): RowKey | null {
  if (identity.keyColumns.length === 0) return null;
  const raw: Record<string, Value> = {};
  const shown: Record<string, Value> = {};
  for (const [i, column] of identity.keyColumns.entries()) {
    const decoded = change.columns.get(column) ?? change.oldKey?.get(column);
    if (!decoded) return null;
    const pgType = identity.keyTypes[i] ?? 'text';
    const text = toWireText(pgType, decoded);
    if (text === undefined) return null;
    raw[column] = visible(pgType, text);
    // The decoder knows nothing about redaction, so a masked key column would
    // otherwise reach `mutations` — a contract field the CLI renders and the
    // envelope carries — in the clear. Caught by the conformance suite, which
    // is the third place that had to be told about masking after the fact.
    shown[column] = masked.has(column) ? maskedValue(pgType) : visible(pgType, text);
  }
  // Through `keyOf`, not a second implementation of it. The token has to be
  // byte-identical to the net view's for the same row, because the CLI's
  // ghost-mutation diff joins the two on exactly this string — and two
  // implementations that must agree are two implementations that will not.
  return reader.keyOf(shown, raw, identity.keyColumns);
}

/**
 * Drops everything that committed before the window opened.
 *
 * The slot is created a moment before the observer freezes its snapshot, so the
 * log's near edge is slightly earlier than the observer's. Cutting by commit is
 * what makes them the same window: `lsn` is per *record*, not per transaction —
 * measured, two inserts in one transaction carry different LSNs — so filtering
 * records individually would split a transaction in half. A transaction is kept
 * whole, or dropped whole, by where its COMMIT landed.
 */
export function withinWindow(
  rows: ReadonlyArray<{ lsn: string; xid: string; data: string }>,
  openedAt: string,
): Array<{ xid: string; data: string }> {
  const commitOf = new Map<string, string>();
  for (const row of rows) {
    if (row.data.startsWith('COMMIT')) commitOf.set(row.xid, row.lsn);
  }
  return rows
    .filter((row) => {
      const commit = commitOf.get(row.xid);
      // No COMMIT record means decoding stopped mid-transaction, which
      // `upto_lsn` is documented not to do. Keeping it is the safe direction:
      // a spurious mutation is visible, a dropped one is not.
      return commit === undefined || compareLsn(commit, openedAt) >= 0;
    })
    .map(({ xid, data }) => ({ xid, data }));
}

/** `A/B` hex pairs, compared as the 64-bit number they name. */
function compareLsn(a: string, b: string): number {
  const parse = (lsn: string) => {
    const [high, low] = lsn.split('/');
    return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`);
  };
  const [x, y] = [parse(a), parse(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Turns a replication-slot error into something the reader can act on.
 *
 * `42704` — the slot is gone between creating it and using it — is almost
 * always a transaction-mode connection pooler handing the two statements to
 * different backends, and a temporary slot belongs to exactly one. That is
 * worth naming: the bare message says the slot does not exist, which reads as
 * a bug in this tool.
 */
export function slotFailure(error: unknown, slot: string): Error {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === '42704') {
    return new Error(
      `The replication slot \`${slot}\` was gone by the time it was read. The wal engine ` +
        `creates a temporary slot, which belongs to one backend — so this is what a ` +
        `transaction-mode connection pooler (PgBouncer in transaction mode, Supavisor on the ` +
        `pooled port) looks like: it moved the two statements to different backends. Connect ` +
        `directly, or to the session-mode port, or use the mvcc-xmin engine, which needs no ` +
        `slot. (${message})`,
    );
  }
  if (code === '42710') {
    return new Error(
      `A replication slot named \`${slot}\` already exists. The name is random per capture, so ` +
        `this most likely means another TupleScope is running against this database. (${message})`,
    );
  }
  if (code === '53400' || /max_replication_slots/.test(message)) {
    return new Error(
      `No replication slot could be created: the server is at \`max_replication_slots\`. ` +
        `\`SELECT slot_name, active, wal_status FROM pg_replication_slots\` shows what is ` +
        `holding them. (${message})`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

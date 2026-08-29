/**
 * The net view: which rows a window changed, and what they look like on both
 * sides of it.
 */

import type pg from 'pg';
import type {
  CaptureScope,
  CaptureWarning,
  Row,
  RowChange,
} from '@tuplescope/core';
import { readKeySets, readRowsByKey } from './images.js';
import type { TableIdentity } from './introspect.js';
import { quoteIdent, RowReader, serializeKey, valuesLookEqual } from './rows.js';

/**
 * What changed, net — one entry per row identity, values read from SQL.
 *
 * The only implementation there is, shared by every engine that reports a net
 * view. That is deliberate. The `wal` engine originally derived row identity
 * from the decoded log and matched it against SQL keys, which meant maintaining
 * a spelling table for every PostgreSQL type whose decoded text differs from
 * its wire text — `bool` prints `true` where the wire says `t`, `bit` prints
 * `B'10101010'` where the wire says `10101010` — and getting one wrong produced
 * the worst output this tool can produce: `changes: []` with no warning, over a
 * write that plainly happened.
 *
 * There is no such table here because there is no such comparison. Both engines
 * find rows the same way, so their net views are identical by construction
 * rather than by a suite of tests happening to agree. What a log-reading engine
 * adds — the order, the transaction grouping, the row that was inserted and
 * deleted before anything could see it — is additive, and lives in
 * `ChangeSet.mutations`.
 *
 *   1. rows written during the window: their inserting transaction was not
 *      visible when the observer froze its snapshot
 *   2. rows that left: present in the before key set, absent from the after one
 *   3. before-images: the same keys read back inside the still-open observer
 *      transaction, which sees the pre-request world
 */
export async function collectNetChanges(
  reader: RowReader,
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
      `SELECT * FROM ${quoteIdent(table.table)}
        WHERE NOT pg_visible_in_snapshot(xmin::text::xid8, $1::pg_snapshot)${where}`,
      [snapshot],
    );

    if (identity.keyColumns.length === 0) {
      // No usable identity: rows can be counted but not paired, so an update
      // is indistinguishable from a delete plus an insert. Say so — and say it
      // whether or not anything turned up.
      //
      // This warning used to be inside the `touched.rows.length > 0` branch
      // below, which meant the one branch that *knows* this table cannot be
      // read properly stayed silent exactly when it had nothing else to
      // report. A DELETE from a keyless table leaves no trace here at all —
      // `readKeySets` skips the table, so there is no before-set to subtract
      // from — and the run then printed "Nothing was written. Not a single row
      // was touched", clean, exit 0, over rows that were really deleted.
      // `hasWrite(changes(*))` returned false, so the idempotency guard this
      // tool exists for passed green.
      warnings.push({
        code: 'degraded-row-identity',
        table: table.table,
        message:
          `\`${table.table}\` has no primary key or unique index, so rows here can be counted ` +
          `but not matched to a previous version. Changes are reported as inserts, and a ` +
          `delete cannot be seen at all.`,
      });
      if (touched.rows.length > 0) {
        for (const raw of touched.rows) {
          const after = reader.toRow(touched.fields, raw, masked);
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

    // Paired on the raw row, masked afterwards.
    //
    // Keying off an already-masked row does not work, because `readKeySets`
    // reads key columns unmasked: the two never match, so a row whose primary
    // key is masked is absent from the before set and comes back as an
    // **insert with no before-image and no warning**. Measured on mvcc-xmin —
    // one `UPDATE` reported `kind: 'insert'`, `before: null`, `warnings: []`,
    // the tool saying a row was created when it was modified.
    //
    // Identity is a fact about the row, not about what the reader is allowed
    // to see, so it is derived before redaction and redaction is applied to
    // what is emitted.
    // Both images are kept: the raw one decides identity and which columns
    // moved, the redacted one is what gets reported.
    //
    // Comparing the redacted rows makes every masked column look unchanged,
    // because both sides are the same placeholder. Measured: a row whose only
    // change was a redacted card number came back with `changedColumns: []` —
    // indistinguishable from `UPDATE t SET x = x`, which is the one comparison
    // this tool exists to make. Redaction hides the value, not the fact that
    // it moved.
    const afterByKey = new Map<string, { raw: Row; shown: Row }>();
    for (const raw of touched.rows) {
      const bare = reader.toRow(touched.fields, raw, new Set());
      afterByKey.set(serializeKey(bare, identity.keyColumns), {
        raw: bare,
        shown: reader.toRow(touched.fields, raw, masked),
      });
    }

    const afterKeys = await readKeySets(worker, reader, { ...scope, tables: [table] }, identities);
    const nowPresent = afterKeys.get(table.table) ?? new Set<string>();
    const wasPresent = beforeKeys.get(table.table) ?? new Set<string>();

    const deletedKeys = [...wasPresent].filter((k) => !nowPresent.has(k));
    const updatedKeys = [...afterByKey.keys()].filter((k) => wasPresent.has(k));

    // The time-travel step: read the previous version of every row we need
    // through the observer, which still sees the pre-request world.
    const beforeRows = await readRowsByKey(
      observer,
      reader,
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
          key: reader.keyOf(after.shown, after.raw, identity.keyColumns),
          kind: 'insert',
          before: null,
          after: after.shown,
          changedColumns: Object.keys(after.shown),
          visibleColumns: Object.keys(after.shown).filter((c) => !ignore.has(c)),
          hasWrite: true,
        });
        continue;
      }
      // Compared raw, reported redacted — and note `keyOf` is deliberately
      // given the redacted row. The real key pairs the two images inside this
      // function and goes no further; a `RowChange` that carried it would put
      // a masked primary key back on screen. Only the comparison sees raw.
      const changedColumns = Object.keys(after.raw).filter(
        (column) => !valuesLookEqual(before.raw[column], after.raw[column]),
      );
      changes.push({
        table: table.table,
        key: reader.keyOf(after.shown, after.raw, identity.keyColumns),
        kind: 'update',
        before: before.shown,
        after: after.shown,
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
        key: reader.keyOf(before.shown, before.raw, identity.keyColumns),
        // A narrowed scope makes absence ambiguous, so say which kind it is.
        kind: table.where ? 'left-scope' : 'delete',
        before: before.shown,
        after: null,
        changedColumns: Object.keys(before.shown),
        visibleColumns: Object.keys(before.shown).filter((c) => !ignore.has(c)),
        hasWrite: true,
      });
    }
  }

  return changes;
}

/**
 * The `relfilenode` of each watched table — the identity of the file its rows
 * actually live in.
 *
 * `TRUNCATE`, `VACUUM FULL`, `CLUSTER` and a rewriting `ALTER TABLE` all give a
 * table a new one. That matters here for a reason measurement made plain: after
 * a `TRUNCATE`, a REPEATABLE READ transaction older than it reads the table as
 * **empty** rather than raising. So an engine that reconstructs before-images
 * from a held snapshot loses them silently, and reports a step that deleted
 * every row as a step that did nothing.
 *
 * Reading `pg_class` takes no lock on the tables themselves — measured, a
 * `TRUNCATE` still completes in under a millisecond alongside it — so this
 * costs one catalogue query on each side of the window and nothing else.
 */
export async function readRelfilenodes(
  client: pg.PoolClient,
  tables: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  if (tables.length === 0) return new Map();
  const { rows } = await client.query<{ relname: string; node: string }>(
    `SELECT relname, relfilenode::text AS node
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace
        AND relkind = 'r'
        AND relname = ANY($1::text[])`,
    [tables],
  );
  return new Map(rows.map((r) => [r.relname, r.node]));
}

/**
 * Says so when a table was rewritten mid-window, because everything the
 * observer knew about it is then gone.
 *
 * `scope-truncated` rather than a softer code on purpose: it escalates the run
 * to `undecided`. An engine that cannot recover what a table held must not let
 * the result read as "nothing happened here", which is exactly what an empty
 * `changes` looks like.
 */
export function reportRewrites(
  before: Map<string, string>,
  after: Map<string, string>,
  warnings: CaptureWarning[],
): void {
  for (const [table, node] of before) {
    const now = after.get(table);
    if (now === node) continue;
    warnings.push({
      code: 'scope-truncated',
      table,
      message:
        now === undefined
          ? `\`${table}\` no longer exists, so what it held during this step cannot be reported.`
          : `\`${table}\` was rewritten during this step — TRUNCATE, VACUUM FULL, CLUSTER or a ` +
            `rewriting ALTER TABLE. Its previous contents are unreachable even from a snapshot ` +
            `taken before the step, so any rows it lost are not in this report.`,
    });
  }
}

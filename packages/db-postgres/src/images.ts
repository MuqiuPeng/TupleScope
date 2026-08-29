/**
 * Reading row images out of PostgreSQL, shared by every engine that reports
 * values.
 *
 * Both mvcc-xmin and wal answer the same two questions once they know which
 * rows were touched: what did the row look like before, and what does it look
 * like now. Neither question has anything to do with how the row was noticed,
 * which is the only thing the two engines actually disagree about — and keeping
 * that seam visible here is what stops "a second engine" from becoming "a
 * second copy of the first engine".
 *
 * Before-images come from a still-open REPEATABLE READ transaction, which sees
 * the world as it was when the window opened. MVCC is the time machine.
 */

import type pg from 'pg';
import type { Row, TableScope } from '@tuplescope/core';
import type { TableIdentity } from './introspect.js';
import { ValueUnavailable } from '@tuplescope/core';
import type { RowsRead } from '@tuplescope/core';
import { parseKey, quoteIdent, RowReader, serializeKey } from './rows.js';

/** Reads only key columns — the cheap half, used to spot rows that left. */

/**
 * Reads whole rows for a set of serialized keys, on whichever connection is
 * passed — the observer transaction for before-images, an ordinary one for
 * after-images.
 *
 * One round trip regardless of key width: a row-value IN list. PostgreSQL
 * infers each parameter's type from the column it sits opposite, so a composite
 * key of mixed types needs no casts.
 */
export async function readRowsByKey(
  client: pg.PoolClient,
  reader: RowReader,
  table: TableScope,
  identity: TableIdentity,
  keys: ReadonlyArray<string>,
  masked: ReadonlySet<string>,
): Promise<Map<string, { raw: Row; shown: Row }>> {
  // Both images: the raw one is what identity and column comparison are
  // derived from, the redacted one is what is reported. Comparing redacted
  // rows makes every masked column look unchanged.
  const out = new Map<string, { raw: Row; shown: Row }>();
  if (keys.length === 0) return out;

  const width = identity.keyColumns.length;
  // Through `parseKey`, not by hand. Reading the encoding here is what broke
  // when it gained a state tag, and the failure was an `UPDATE` reported as an
  // `insert` rather than an error.
  const keyValues = keys.map(parseKey).filter((v): v is Array<string | null> => v !== null);
  if (keyValues.length === 0) return out;
  const tuple = `(${identity.keyColumns.map((c) => quoteIdent(c)).join(', ')})`;
  const placeholders = keyValues
    .map((_, i) => `(${identity.keyColumns.map((__, j) => `$${i * width + j + 1}`).join(', ')})`)
    .join(', ');

  const result = await client.query(
    `SELECT * FROM ${quoteIdent(table.table)} WHERE ${tuple} IN (${placeholders})`,
    keyValues.flat(),
  );

  for (const raw of result.rows) {
    // Keyed on the raw row, masked on the way out — the same rule as the net
    // view. Keying off the masked row makes every key on a redacted column
    // collapse to one placeholder, so nothing pairs and an `UPDATE` is
    // reported as an insert with no before-image.
    const bare = reader.toRow(result.fields, raw, new Set());
    out.set(serializeKey(bare, identity.keyColumns), {
      raw: bare,
      shown: reader.toRow(result.fields, raw, masked),
    });
  }
  return out;
}

/**
 * Rows as they are now, shaped as `RowChange`es so a selector can read them.
 *
 * Both images are the current row, because that is what happened to a row
 * nothing wrote: `delta` over it is zero, which is true. `hasWrite` is false
 * and `changedColumns` empty for the same reason.
 *
 * The predicate arrives already split into columns and values and is bound as
 * parameters. It comes from a scenario file and can carry a captured value, so
 * building a statement out of its text would be an injection — and a tool whose
 * claim is that it only observes has no business having one.
 */
/**
 * The keys that left the table during the step.
 *
 * Replaces subtracting one full key scan from another. Those two scans existed
 * only to compute this set, and they cost the whole table twice on every step
 * whether or not anything was written — measured on 800k rows: 196 ms and
 * 800,000 rows across the wire, each way, against 20 ms and 4 rows for this.
 * The constant becomes proportional to what was *written* rather than to what
 * is *stored*, which is also what removes the memory ceiling.
 *
 * Read through the observer, whose snapshot still holds the pre-request world,
 * so a row deleted during the step is still there to be found with its `xmax`
 * set to whatever removed it.
 *
 * **Deliberately no visibility filter on `xmax`.** Narrowing the candidates
 * with `NOT pg_visible_in_snapshot(xmax::text::xid8, …)` would introduce two
 * ways to miss a real delete: `xmax` holds a multixact id once more than one
 * transaction has touched the row, and reading that as an xid8 is meaningless;
 * and the `::xid8` conversion is epoch-blind, so past the first epoch the
 * answer is wrong for every row. Over-including costs one keyed lookup.
 * Under-including is a deleted row reported as nothing at all — the failure
 * this tool exists to prevent.
 *
 * So every row carrying any `xmax` is a candidate — an update's superseded
 * version, a lock, a rolled-back delete — and presence *now* is what decides.
 * A row that is still there did not leave.
 */
export async function readDepartedKeys(
  observer: pg.PoolClient,
  worker: pg.PoolClient,
  reader: RowReader,
  table: TableScope,
  identity: TableIdentity,
): Promise<string[]> {
  const columns = identity.keyColumns.map((c) => quoteIdent(c)).join(', ');
  const where = table.where ? ` AND (${table.where})` : '';
  const candidates = await observer.query(
    `SELECT ${columns} FROM ${quoteIdent(table.table)} WHERE xmax <> '0'${where}`,
  );
  if (candidates.rows.length === 0) return [];

  const keyed = candidates.rows.map((raw) => ({
    key: serializeKey(reader.toRow(candidates.fields, raw, new Set()), identity.keyColumns),
    values: identity.keyColumns.map((c) => raw[c]),
  }));

  // One keyed read of the candidates as they are now. A single-column key takes
  // `= ANY`, which plans better and is the overwhelmingly common case; a
  // composite key needs the row-constructor form.
  // The watch predicate applies to the existence check as well, and it is
  // load-bearing rather than symmetry for its own sake. A row that stops
  // matching `watch:` has *left the scope* — it is still in the table, and this
  // capture is supposed to report it as gone. Checking presence without the
  // predicate finds it, calls it present, and loses the `left-scope` change
  // entirely.
  const survived =
    identity.keyColumns.length === 1
      ? await worker.query(
          `SELECT ${columns} FROM ${quoteIdent(table.table)} ` +
            `WHERE ${quoteIdent(identity.keyColumns[0]!)} = ANY($1)${where}`,
          [keyed.map((k) => k.values[0])],
        )
      : await worker.query(
          `SELECT ${columns} FROM ${quoteIdent(table.table)} WHERE (${columns}) IN (${keyed
            .map(
              (_, i) =>
                `(${identity.keyColumns
                  .map((__, j) => `$${i * identity.keyColumns.length + j + 1}`)
                  .join(', ')})`,
            )
            .join(', ')})${where}`,
          keyed.flatMap((k) => k.values),
        );

  const present = new Set(
    survived.rows.map((raw) =>
      serializeKey(reader.toRow(survived.fields, raw, new Set()), identity.keyColumns),
    ),
  );
  return keyed.filter((k) => !present.has(k.key)).map((k) => k.key);
}

export async function readCurrentRows(
  client: pg.PoolClient,
  reader: RowReader,
  table: TableScope,
  identity: TableIdentity | undefined,
  clauses: ReadonlyArray<{ column: string; value: string | null }>,
  limit: number,
): Promise<RowsRead> {
  const masked = new Set(table.maskedColumns);
  // Refused before the query is issued, not after the rows come back.
  //
  // The database can answer `plan = 'pro'` perfectly well — masking is applied
  // on the way out, so the WHERE runs against the real column. That makes the
  // *row count* an oracle: ask `= 'pro'`, then `= 'free'`, and the redacted
  // value falls out in as many questions as there are candidates. Measured
  // before this guard: `plan = pro` returned 1 row, `plan = free` returned 1,
  // `plan = nonsense` returned 0. The questions come from a scenario file,
  // which came from the repository.
  const askedAbout = clauses.filter((c) => masked.has(c.column)).map((c) => c.column);
  if (askedAbout.length > 0) {
    throw new ValueUnavailable(
      `\`${table.table}.${askedAbout.join('`, `')}\` ${askedAbout.length === 1 ? 'is' : 'are'} ` +
        'masked at capture, so a predicate cannot be matched against ' +
        `${askedAbout.length === 1 ? 'it' : 'them'}. ` +
        'Remove the column from `maskColumns` if the selector needs it.',
    );
  }
  // `IS NULL` for a null literal, because `col = NULL` is never true in SQL and
  // `col::text = 'null'` matches the four characters. `count(rows(t, col =
  // null)) == 0` used to pass over a table with a real NULL in it — answerable,
  // wrongly, as a green. Parameters are numbered over the non-null clauses only.
  const params: string[] = [];
  const where = [
    ...clauses.map((c) =>
      c.value === null
        ? `${quoteIdent(c.column)} IS NULL`
        : `${quoteIdent(c.column)}::text = $${params.push(c.value)}`,
    ),
    ...(table.where ? [`(${table.where})`] : []),
  ];

  const result = await client.query(
    `SELECT * FROM ${quoteIdent(table.table)}` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      // One more than asked for. Reading exactly `limit` cannot tell a table
      // with exactly that many rows from one with ten thousand, and the
      // difference decides whether a count is a total or a lower bound.
      ` LIMIT ${limit + 1}`,
    params,
  );

  const complete = result.rows.length <= limit;
  const rows = (complete ? result.rows : result.rows.slice(0, limit)).map((raw) => {
    // Both images here too. This is the `rows(...)` selector path, and it used
    // to be the one place a key was derived from the redacted row — so every
    // row of a table with a masked key column correlated as the same row.
    const bare = reader.toRow(result.fields, raw, new Set());
    const row = reader.toRow(result.fields, raw, masked);
    return {
      table: table.table,
      key: identity ? reader.keyOf(row, bare, identity.keyColumns) : null,
      kind: 'unchanged' as const,
      before: row,
      after: row,
      changedColumns: [],
      visibleColumns: [],
      hasWrite: false,
    };
  });
  return complete ? { rows, complete: true } : { rows, complete: false, limit };
}

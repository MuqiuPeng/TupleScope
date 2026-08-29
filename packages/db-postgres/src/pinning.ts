/**
 * The session settings that decide how a value's text is rendered.
 *
 * Every captured value is text, and text is not a property of the value alone:
 * it is the value plus the settings of the session that printed it. The same
 * `timestamptz` prints as `2024-03-01 12:00:00+00` under `DateStyle=ISO` and
 * `01/03/2024 12:00:00 GMT` under `SQL,DMY`, and a statement built from the
 * second one addresses a different row — or none.
 *
 * That does not matter while the text only ever travels back to the connection
 * that produced it. It matters the moment the text is handed to a second tool,
 * which is the whole point of the row handoff: measured against Adminer,
 * `timestamptz` matched by equality on its wire text only because the rendering
 * carried an explicit `+00` offset.
 *
 * So the settings are pinned on connect *and read back*. Pinning alone is a
 * claim; a pool handed out a connection whose `SET` quietly failed would still
 * look pinned from here.
 */

import type pg from 'pg';
import type { CaptureWarning } from '@tuplescope/core';

/**
 * Set on every capture connection. Values are the form `current_setting`
 * returns, so a read-back compares without normalising.
 */
export const PINNED_SETTINGS = {
  DateStyle: 'ISO, MDY',
  TimeZone: 'UTC',
  bytea_output: 'hex',
  IntervalStyle: 'iso_8601',
  extra_float_digits: '1',
} as const;

export type PinnedSetting = keyof typeof PINNED_SETTINGS;

/** The rendering settings a capture actually ran under. */
export type Rendering = Readonly<Record<PinnedSetting, string>>;

const NAMES = Object.keys(PINNED_SETTINGS) as PinnedSetting[];

/**
 * `SET` rather than the connection string's `options=`.
 *
 * A DSN may already carry `options=-c search_path=…`, and merging into it means
 * parsing and rebuilding a string the user wrote. Getting that wrong changes
 * the search path, which silently captures a different schema — a worse failure
 * than the one being fixed. Measured: node-postgres queues queries on a client
 * in order, so a `SET` issued from the `connect` handler is on the wire before
 * whatever the borrower asks for next, without awaiting it here.
 */
export function pinPool(pool: pg.Pool): void {
  const statement = NAMES.map((name) => `SET ${name} = ${quoteSetting(PINNED_SETTINGS[name])}`).join(
    '; ',
  );
  pool.on('connect', (client) => {
    // Failure is not swallowed and not thrown from an event handler either: the
    // read-back below is what turns it into a warning the run can carry.
    void client.query(statement).catch(() => {});
  });
}

/** `extra_float_digits` is an integer GUC and rejects a quoted value. */
function quoteSetting(value: string): string {
  return /^-?\d+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

/** What this connection will actually render with. One round trip. */
export async function readRendering(client: pg.PoolClient | pg.Client): Promise<Rendering> {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT ${NAMES.map((n, i) => `current_setting('${n}') AS s${i}`).join(', ')}`,
  );
  const row = rows[0] ?? {};
  return Object.fromEntries(NAMES.map((n, i) => [n, row[`s${i}`] ?? ''])) as Rendering;
}

/**
 * Settings that are not what was pinned, if any.
 *
 * A pooler that resets session state, a `SET` rejected by a permission, or a
 * `pg_service` entry that sets its own — each leaves the connection rendering
 * under something else, and each is silent from the driver's side.
 */
export function renderingDrift(actual: Rendering): PinnedSetting[] {
  return NAMES.filter((name) => actual[name] !== PINNED_SETTINGS[name]);
}

/**
 * Reads what this connection actually renders with, and says so if it is not
 * what was pinned.
 *
 * Per capture rather than per pool, and on the connection that reads values
 * rather than any connection: a pooler in transaction mode can hand the same
 * `pg.PoolClient` a different backend, and a `SET` that succeeded on connect
 * says nothing about the session serving this query.
 */
export async function verifyRendering(
  client: pg.PoolClient | pg.Client,
  warnings: CaptureWarning[],
): Promise<Rendering> {
  const rendering = await readRendering(client);
  const drift = renderingDrift(rendering);
  if (drift.length > 0) {
    warnings.push({
      code: 'rendering-not-pinned',
      message:
        `Values were rendered under ${drift
          .map((name) => `${name} = ${rendering[name]} (expected ${PINNED_SETTINGS[name]})`)
          .join(', ')}. ` +
        'The captured text is still correct for this connection, but it is not ' +
        'portable: a statement built from it may address a different row in a ' +
        'session that renders differently.',
    });
  }
  return rendering;
}

/**
 * Keep a dead idle connection from taking the process with it.
 *
 * `pg` emits `error` on the *pool* when a pooled client's socket dies while
 * idle — a database restart, a pgbouncer recycle, a laptop waking, a blip in
 * CI. That event is outside every promise chain, so an unhandled one is a hard
 * crash: 257 lines of driver internals and **exit 1**, which this CLI's own
 * table defines as "a check failed — the system under test is wrong". A
 * network hiccup reported to a team as a bug in their backend. In the runtime
 * it is worse: the whole server dies, taking every UI session and all
 * in-memory run history, and leaving a stale session file behind because the
 * shutdown path never runs.
 *
 * Recording it rather than rethrowing. The next query fails on its own and
 * reports through the normal path, with the workspace's own remedy attached;
 * throwing from here would only reproduce the crash with a nicer message.
 */
export function absorbIdleErrors(pool: pg.Pool, note?: (error: Error) => void): void {
  pool.on('error', (error: Error) => {
    note?.(error);
  });
}

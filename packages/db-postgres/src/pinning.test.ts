/**
 * Whether the pin holds, and whether a broken pin is noticed.
 *
 * The second half is the one that matters. Pinning alone is a claim: a `SET`
 * rejected by a permission, or a pooler that resets session state between
 * checkouts, leaves the connection rendering under something else and says
 * nothing. The read-back is what turns that into a fact the run carries.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import type { CaptureWarning } from '@tuplescope/core';
import { absorbIdleErrors, PINNED_SETTINGS, readRendering, renderingDrift, verifyRendering } from './pinning.js';
import { MvccPostgresAdapter } from './mvcc-adapter.js';
import { textIfVisible } from '@tuplescope/core';

const BASE_URL =
  process.env['TUPLESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

const SCHEMA = 'tuplescope_pin_test';
const CONNECTION = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(
  `-c search_path=${SCHEMA}`,
)}`;

const available = await (async (): Promise<boolean> => {
  const probe = new pg.Pool({ connectionString: BASE_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
})();

let admin: pg.Client;

before(async () => {
  if (!available) return;
  admin = new pg.Client({ connectionString: CONNECTION });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.query(`CREATE TABLE t (id text PRIMARY KEY, ts timestamptz, iv interval, b bytea)`);
});

after(async () => {
  if (!available) return;
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

describe('rendering settings', () => {
  it('are what the adapter pinned, on the connection that reads values', async (t) => {
    if (!available) return t.skip('no database');
    const adapter = new MvccPostgresAdapter({ connectionString: CONNECTION });
    try {
      const scope = await adapter.fullScope();
      const writer = new pg.Client({ connectionString: CONNECTION });
      await writer.connect();
      const { changes } = await adapter.capture(scope, async () => {
        await writer.query(
          `INSERT INTO t VALUES ('r1', '2024-03-01 12:00:00+00', '1 day 2 hours', '\\x0102')`,
        );
      });
      await writer.end();

      assert.deepEqual({ ...changes.rendering }, { ...PINNED_SETTINGS });
      assert.deepEqual(
        changes.warnings.filter((w) => w.code === 'rendering-not-pinned'),
        [],
      );

      // The point of pinning, in the values themselves. Each of these renders
      // differently under the stock settings of some other session, and each
      // would then address a different row — or none.
      const row = changes.changes.find((c) => c.table === 't')?.after;
      assert.equal(textIfVisible(row?.['ts']), '2024-03-01 12:00:00+00', 'timestamptz needs its offset');
      assert.equal(textIfVisible(row?.['iv']), 'P1DT2H', 'interval under IntervalStyle=iso_8601');
      assert.equal(textIfVisible(row?.['b']), '\\x0102', 'bytea under bytea_output=hex');
    } finally {
      await adapter.close();
    }
  });

  it('report drift rather than assuming the SET took', async (t) => {
    if (!available) return t.skip('no database');
    const client = new pg.Client({ connectionString: BASE_URL });
    await client.connect();
    try {
      // Exactly what a pg_service entry or a pooler reset looks like from here:
      // a live connection that was never pinned.
      await client.query(`SET IntervalStyle = 'postgres'`);
      await client.query(`SET TimeZone = 'Asia/Shanghai'`);

      const rendering = await readRendering(client);
      assert.deepEqual(renderingDrift(rendering).sort(), ['IntervalStyle', 'TimeZone']);

      const warnings: CaptureWarning[] = [];
      await verifyRendering(client, warnings);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.code, 'rendering-not-pinned');
      // The message has to name the setting and both values, or the reader
      // cannot tell which of five things went wrong.
      assert.match(warnings[0]!.message, /IntervalStyle = postgres \(expected iso_8601\)/);
      assert.match(warnings[0]!.message, /TimeZone = Asia\/Shanghai \(expected UTC\)/);
      // ...and it has to say what is actually lost, which is not correctness.
      assert.match(warnings[0]!.message, /still correct for this connection/);
      assert.match(warnings[0]!.message, /not\s+portable/);
    } finally {
      await client.end();
    }
  });

  it('leave a DSN that already carries options= alone', async (t) => {
    if (!available) return t.skip('no database');
    // The reason pinning is a SET and not a merge into the connection string:
    // getting that merge wrong changes search_path, which silently captures a
    // different schema — a worse failure than the one being fixed.
    const adapter = new MvccPostgresAdapter({ connectionString: CONNECTION });
    try {
      const scope = await adapter.fullScope();
      assert.equal(scope.schema, SCHEMA, 'the DSN-supplied search_path must survive pinning');
    } finally {
      await adapter.close();
    }
  });
});

describe('an idle connection that dies', () => {
  /**
   * `pg` raises this on the pool, outside every promise chain. Unhandled, it is
   * a hard crash and **exit 1** — which this CLI's own table defines as "the
   * system under test is wrong". A database restart, a pgbouncer recycle or a
   * blip in CI would be reported to a team as a bug in their backend.
   */
  it('does not take the process with it', async (t) => {
    if (!available) return t.skip('no database');
    const pool = new pg.Pool({ connectionString: BASE_URL, max: 2 });
    absorbIdleErrors(pool);

    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]!.pid;
    client.release(); // now idle in the pool, which is the case that crashes

    const killer = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    absorbIdleErrors(killer);
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await killer.end();
    }

    // The error arrives asynchronously; reaching the next line at all is the
    // assertion. Without the handler this test file exits before it.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(true, 'still running');

    // And the pool is still usable: the dead client was discarded, not kept.
    const after = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(after.rows[0]!.ok, 1);
    await pool.end();
  });

  it('hands the error to a caller that wants to see it', async (t) => {
    if (!available) return t.skip('no database');
    const seen: Error[] = [];
    const pool = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    absorbIdleErrors(pool, (error) => seen.push(error));

    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    client.release();

    const killer = new pg.Pool({ connectionString: BASE_URL, max: 1 });
    absorbIdleErrors(killer);
    await killer.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
    await killer.end();

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(seen.length, 1, 'the note should have been called exactly once');
    assert.match(seen[0]!.message, /terminat|connection/i);
    await pool.end();
  });
});

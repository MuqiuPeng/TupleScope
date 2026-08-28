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
import type { CaptureWarning } from '@statescope/core';
import { PINNED_SETTINGS, readRendering, renderingDrift, verifyRendering } from './pinning.js';
import { MvccPostgresAdapter } from './mvcc-adapter.js';
import { textIfVisible } from '@statescope/core';

const BASE_URL =
  process.env['STATESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

const SCHEMA = 'statescope_pin_test';
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

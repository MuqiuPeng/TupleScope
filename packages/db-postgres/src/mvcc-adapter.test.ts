/**
 * Integration tests for the capture engine, against a real PostgreSQL.
 *
 * These cannot be faked. The engine's whole claim rests on how Postgres MVCC
 * actually behaves — that a held REPEATABLE READ snapshot still sees the old
 * row, that `xmin` moves on a write that changes nothing, that a rolled-back
 * write leaves nothing behind. A mock would just restate my assumptions back
 * to me.
 *
 * Point them at any throwaway database:
 *
 *   STATESCOPE_TEST_DATABASE_URL=postgresql://... pnpm --filter @statescope/db-postgres test
 *
 * With nothing set they use the demo-bank cluster on :7432, and skip entirely
 * if it is not up — so `pnpm test` stays green on a machine with no database.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import type { CaptureScope, ChangeSet, RowChange } from '@statescope/core';
import { MvccPostgresAdapter } from './mvcc-adapter.js';

const BASE_URL =
  process.env['STATESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

const SCHEMA = 'statescope_test';

/**
 * Pin every connection to the test schema via a connection-string option, so
 * the adapter's `current_schema()` lands here without touching the database's
 * own settings or any other session.
 */
const CONNECTION = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(
  `-c search_path=${SCHEMA}`,
)}`;

/**
 * Probed at module load, not in `before()`: the test runner reads a suite's
 * skip flag while loading the file, so a flag set later would come too late and
 * the suite would always skip.
 */
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

let adapter: MvccPostgresAdapter;
let sql: pg.Pool;

before(async () => {
  if (!available) return;

  // The schema has to exist before anything sets search_path to it.
  const bootstrap = new pg.Pool({ connectionString: BASE_URL, max: 1 });
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
  await bootstrap.end();

  sql = new pg.Pool({ connectionString: CONNECTION, max: 4 });
  await sql.query(`
    CREATE TABLE accounts (
      id      text PRIMARY KEY,
      balance numeric(14,2) NOT NULL,
      status  text NOT NULL DEFAULT 'ACTIVE',
      meta    jsonb NOT NULL DEFAULT '{}',
      -- Unconstrained numeric and bigint: numeric(14,2) tops out below
      -- Number.MAX_SAFE_INTEGER, so it cannot show the precision loss.
      huge    numeric,
      counter bigint,
      touched timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE legs (
      account_id text NOT NULL,
      seq        int  NOT NULL,
      amount     numeric(14,2) NOT NULL,
      PRIMARY KEY (account_id, seq)
    );
    CREATE TABLE audit (
      note text NOT NULL
    );
    INSERT INTO accounts (id, balance) VALUES ('acc_a', 1000.00), ('acc_b', 500.00);
    INSERT INTO legs VALUES ('acc_a', 1, 10.00);
  `);

  adapter = new MvccPostgresAdapter({ connectionString: CONNECTION });
});

after(async () => {
  if (!available) return;
  await adapter.close();
  const bootstrap = new pg.Pool({ connectionString: BASE_URL, max: 1 });
  await bootstrap.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await bootstrap.end();
  await sql.end();
});

async function scope(): Promise<CaptureScope> {
  return adapter.fullScope();
}

/** Runs `work` inside a capture window and returns what the engine saw. */
async function observe(work: string | (() => Promise<void>)): Promise<ChangeSet> {
  const s = await scope();
  const { changes } = await adapter.capture(s, async () => {
    if (typeof work === 'string') await sql.query(work);
    else await work();
  });
  return changes;
}

const forTable = (c: ChangeSet, table: string): RowChange[] =>
  c.changes.filter((x) => x.table === table);

const keyOf = (c: RowChange): string =>
  c.key?.columns.map((k) => `${k.column}=${k.value.text}`).join(',') ?? '(none)';

describe('MvccPostgresAdapter', { skip: available ? false : 'no PostgreSQL reachable' }, () => {
  it('finds an insert and carries the row', async () => {
    const changes = await observe(
      `INSERT INTO accounts (id, balance) VALUES ('acc_new', 1.00)`,
    );
    const rows = forTable(changes, 'accounts');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'insert');
    assert.equal(rows[0]!.before, null);
    assert.equal(rows[0]!.after!['balance']!.text, '1.00');
    assert.equal(rows[0]!.after!['balance']!.pgType, 'numeric');
    assert.equal(keyOf(rows[0]!), 'id=acc_new');
    await sql.query(`DELETE FROM accounts WHERE id = 'acc_new'`);
  });

  it('recovers the before image of an update through MVCC', async () => {
    // The heart of the engine: the observer transaction is still open, so the
    // pre-request version of the row is still readable.
    const changes = await observe(
      `UPDATE accounts SET balance = 900.00, status = 'HELD' WHERE id = 'acc_a'`,
    );
    const [row] = forTable(changes, 'accounts');
    assert.equal(row!.kind, 'update');
    assert.equal(row!.before!['balance']!.text, '1000.00');
    assert.equal(row!.after!['balance']!.text, '900.00');
    assert.deepEqual([...row!.changedColumns].sort(), ['balance', 'status']);
    await sql.query(`UPDATE accounts SET balance = 1000.00, status = 'ACTIVE' WHERE id = 'acc_a'`);
  });

  it('finds a delete and carries the row that is gone', async () => {
    await sql.query(`INSERT INTO accounts (id, balance) VALUES ('acc_doomed', 5.00)`);
    const changes = await observe(`DELETE FROM accounts WHERE id = 'acc_doomed'`);
    const [row] = forTable(changes, 'accounts');
    assert.equal(row!.kind, 'delete');
    assert.equal(row!.after, null);
    assert.equal(row!.before!['balance']!.text, '5.00');
  });

  it('sees a write that changes no value at all', async () => {
    // The reason this engine exists. A before/after value comparison reports
    // nothing here; the row was still rewritten.
    const changes = await observe(
      `UPDATE accounts SET balance = balance WHERE id = 'acc_a'`,
    );
    const [row] = forTable(changes, 'accounts');
    assert.ok(row, 'the write should have been detected');
    assert.equal(row!.kind, 'update');
    assert.deepEqual(row!.changedColumns, []);
    assert.equal(row!.hasWrite, true);
  });

  it('does not report a rolled-back write', async () => {
    const changes = await observe(async () => {
      const client = await sql.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE accounts SET balance = 0 WHERE id = 'acc_a'`);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
    assert.deepEqual(forTable(changes, 'accounts'), []);
  });

  it('reports nothing when nothing happened', async () => {
    const changes = await observe(async () => {});
    assert.deepEqual(changes.changes, []);
    assert.deepEqual(changes.warnings, []);
    assert.equal(changes.detection, 'write');
  });

  it('handles a composite primary key', async () => {
    const changes = await observe(
      `INSERT INTO legs VALUES ('acc_b', 7, 42.00)`,
    );
    const [row] = forTable(changes, 'legs');
    assert.equal(row!.key!.columns.length, 2);
    assert.equal(keyOf(row!), 'account_id=acc_b,seq=7');
    await sql.query(`DELETE FROM legs WHERE account_id = 'acc_b' AND seq = 7`);
  });

  it('pairs an update on a composite key rather than mismatching it', async () => {
    const changes = await observe(`UPDATE legs SET amount = 11.00 WHERE seq = 1`);
    const [row] = forTable(changes, 'legs');
    assert.equal(row!.kind, 'update');
    assert.equal(row!.before!['amount']!.text, '10.00');
    assert.equal(row!.after!['amount']!.text, '11.00');
    await sql.query(`UPDATE legs SET amount = 10.00 WHERE seq = 1`);
  });

  it('degrades honestly on a table with no key, and warns', async () => {
    const changes = await observe(`INSERT INTO audit (note) VALUES ('hello')`);
    const [row] = forTable(changes, 'audit');
    assert.equal(row!.key, null);
    const warning = changes.warnings.find((w) => w.table === 'audit');
    assert.equal(warning?.code, 'degraded-row-identity');
    assert.match(warning!.message, /no primary key or unique index/);
    await sql.query(`DELETE FROM audit`);
  });

  it('keeps numeric and jsonb as exact text, never as JS values', async () => {
    await sql.query(
      `INSERT INTO accounts (id, balance, huge, counter, meta)
       VALUES ('acc_precise', 1.00, 9007199254740993.01, 9007199254740993, '{"b":2,"a":1}')`,
    );
    const changes = await observe(
      `UPDATE accounts SET status = 'X' WHERE id = 'acc_precise'`,
    );
    const [row] = forTable(changes, 'accounts');
    // Number() rounds both of these to ...992; the text must survive intact.
    assert.equal(row!.after!['huge']!.text, '9007199254740993.01');
    assert.equal(row!.after!['counter']!.text, '9007199254740993');
    // Comparing against a JS literal would not work — the literal itself is
    // already rounded at parse time. Round-trip the text instead.
    assert.notEqual(String(Number(row!.after!['counter']!.text)), '9007199254740993');
    assert.equal(row!.after!['meta']!.pgType, 'jsonb');
    assert.equal(typeof row!.after!['meta']!.text, 'string');
    await sql.query(`DELETE FROM accounts WHERE id = 'acc_precise'`);
  });

  it('separates ignored columns from the fact of the write', async () => {
    const base = await scope();
    const scoped: CaptureScope = {
      ...base,
      tables: base.tables.map((t) => ({ ...t, ignoreColumns: ['touched'] })),
    };
    const { changes } = await adapter.capture(scoped, async () => {
      await sql.query(`UPDATE accounts SET touched = now() WHERE id = 'acc_a'`);
    });
    const [row] = forTable(changes, 'accounts');
    assert.deepEqual(row!.changedColumns, ['touched']);
    assert.deepEqual(row!.visibleColumns, []); // nothing worth showing...
    assert.equal(row!.hasWrite, true); //          ...but the write happened
  });

  it('masks configured columns before the value leaves the adapter', async () => {
    const base = await scope();
    const scoped: CaptureScope = {
      ...base,
      tables: base.tables.map((t) => ({ ...t, maskedColumns: ['balance'] })),
    };
    const { changes } = await adapter.capture(scoped, async () => {
      await sql.query(`UPDATE accounts SET balance = 1000.00 WHERE id = 'acc_a'`);
    });
    const [row] = forTable(changes, 'accounts');
    assert.notEqual(row!.after!['balance']!.text, '1000.00');
    assert.match(row!.after!['balance']!.text!, /•/);
  });

  it('narrows to a watch predicate, and calls a row leaving it left-scope', async () => {
    const base = await scope();
    const narrowed: CaptureScope = {
      allTables: false,
      tables: base.tables
        .filter((t) => t.table === 'accounts')
        .map((t) => ({ ...t, where: `status = 'ACTIVE'` })),
    };
    const { changes } = await adapter.capture(narrowed, async () => {
      await sql.query(`UPDATE accounts SET status = 'CLOSED' WHERE id = 'acc_b'`);
    });
    const [row] = forTable(changes, 'accounts');
    // The row was not deleted — it stopped matching. Conflating the two would
    // report a closed account as a vanished one.
    assert.equal(row!.kind, 'left-scope');
    await sql.query(`UPDATE accounts SET status = 'ACTIVE' WHERE id = 'acc_b'`);
  });

  it('reports a quiet database as quiet', async () => {
    const noise = await adapter.probeBaselineNoise(await scope(), 120);
    assert.deepEqual(noise.changes, []);
    assert.deepEqual(noise.warnings, []);
  });

  it('flags a database that writes on its own', async () => {
    const s = await scope();
    const writer = setTimeout(() => {
      void sql.query(`UPDATE accounts SET touched = now() WHERE id = 'acc_a'`);
    }, 40);
    const noise = await adapter.probeBaselineNoise(s, 300);
    clearTimeout(writer);
    assert.ok(noise.changes.length > 0, 'the background write should have been seen');
    assert.equal(noise.warnings.at(-1)?.code, 'concurrent-writes-detected');
  });

  it('releases the observer transaction even when the step throws', async () => {
    const s = await scope();
    await assert.rejects(
      adapter.capture(s, async () => {
        throw new Error('step blew up');
      }),
      /step blew up/,
    );
    // If the transaction had leaked, this would block or exhaust the pool.
    const after = await observe(async () => {});
    assert.deepEqual(after.changes, []);
    const { rows } = await sql.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'idle in transaction'`,
    );
    assert.equal(rows[0]!.n, '0', 'no observer transaction should be left open');
  });
});

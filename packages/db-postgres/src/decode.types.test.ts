/**
 * The guard against the next `bool`.
 *
 * A key column's text has to mean the same thing whether it came from a
 * `SELECT` or from the decoded write-ahead log. Two types broke that quietly —
 * `bool` prints `true` where the wire says `t`, `bit` prints `B'10101010'`
 * where the wire says `10101010` — and the result was a ChangeSet reporting no
 * changes at all over a write that plainly happened, with no warning.
 *
 * Reasoning about which types agree is exactly what produced that bug. So this
 * asks PostgreSQL: it builds a table with a column of every type that could
 * plausibly carry a key, updates a row, and compares the decoder's rendering
 * of each column — after normalisation — against what a raw `SELECT` returns.
 * A third type joining the family fails here rather than in someone's report.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { decodeStream, toWireText } from './decode.js';

const BASE_URL =
  process.env['TUPLESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';
const SCHEMA = 'tuplescope_decode_types';
const CONNECTION = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(
  `-c search_path=${SCHEMA}`,
)}`;

/** name, DDL type, a literal to insert. */
const TYPES: ReadonlyArray<readonly [string, string, string]> = [
  ['int2', 'smallint', '42'],
  ['int4', 'integer', '42'],
  ['int8', 'bigint', '9007199254740993'],
  ['numeric', 'numeric(20,4)', "'123.4500'"],
  ['float4', 'real', '1.5'],
  ['float8', 'double precision', '0.1'],
  ['bool', 'boolean', 'true'],
  ['bit', 'bit(8)', "B'10101010'"],
  ['varbit', 'bit varying(8)', "B'1010'"],
  ['text', 'text', "'hi'"],
  ['varchar', 'varchar(8)', "'hi'"],
  ['bpchar', 'char(4)', "'hi'"],
  ['uuid', 'uuid', "'00000000-0000-0000-0000-000000000001'"],
  ['date', 'date', "'2026-01-02'"],
  ['timestamptz', 'timestamptz', "'2026-01-02 03:04:05+10'"],
  ['timestamp', 'timestamp', "'2026-01-02 03:04:05'"],
  ['time', 'time', "'03:04:05'"],
  ['interval', 'interval', "'1 day 2 hours'"],
  ['bytea', 'bytea', "'\\x00ff'"],
  ['inet', 'inet', "'10.0.0.1'"],
  ['macaddr', 'macaddr', "'08:00:2b:01:02:03'"],
  ['money', 'money', '12.34'],
  ['oid', 'oid', '42'],
  ['int4range', 'int4range', "'[1,5)'"],
  ['json', 'json', `'{"b":1}'`],
  ['jsonb', 'jsonb', `'{"b":1}'`],
  // The rest of what the catalogue says a btree can index.
  ['char', '"char"', "'x'"],
  ['macaddr8', 'macaddr8', "'08:00:2b:01:02:03:04:05'"],
  ['name', 'name', "'thing'"],
  ['pg_lsn', 'pg_lsn', "'0/16B3748'"],
  ['timetz', 'timetz', "'03:04:05+10'"],
  ['tsvector', 'tsvector', "'a b'"],
  ['xid8', 'xid8', "'42'"],
  // Not a key type, but it shares the code path and has its own trap.
  ['textarr', 'text[]', `ARRAY['a','b,c']`],
];

const RAW = { getTypeParser: () => (v: string) => v };

let reachable = false;
let client: pg.Client;
let raw: pg.Client;

before(async () => {
  client = new pg.Client({ connectionString: CONNECTION, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
  } catch {
    console.error(`\n  no database at ${BASE_URL} — decoder type check skipped\n`);
    return;
  }
  const level = (await client.query<{ wal_level: string }>('SHOW wal_level')).rows[0]!.wal_level;
  if (level !== 'logical') {
    console.error(`\n  wal_level is \`${level}\` — decoder type check skipped\n`);
    await client.end();
    return;
  }
  reachable = true;
  raw = new pg.Client({ connectionString: CONNECTION, types: RAW as never });
  await raw.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query('SET synchronous_commit = on');
});

after(async () => {
  if (!reachable) return;
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await Promise.all([client.end(), raw.end()]);
});

describe('every type renders the same both ways', () => {
  it('agrees on all of them, or names the ones it does not', async (t) => {
    if (!reachable) return t.skip('no database with logical decoding');

    const columns = TYPES.map(([name, ddl]) => `${name}_c ${ddl}`).join(', ');
    await client.query(`CREATE TABLE t (id int PRIMARY KEY, ${columns}, tag text)`);
    await client.query(`INSERT INTO t VALUES (1, ${TYPES.map(([, , v]) => v).join(', ')}, 'a')`);
    await client.query(`SELECT pg_create_logical_replication_slot('types_probe','test_decoding', true)`);
    await client.query(`UPDATE t SET tag = 'b' WHERE id = 1`);

    const stream = await client.query<{ xid: string; data: string }>(
      `SELECT xid::text AS xid, data FROM pg_logical_slot_get_changes('types_probe', NULL, NULL)`,
    );
    const { mutations: all, problems } = decodeStream(stream.rows);
    assert.deepEqual(problems, [], 'the stream should parse cleanly');
    // A slot decodes the whole database, not one schema, so anything else
    // writing to this server lands in the same stream. Measured: running the
    // suites in parallel put a conformance row in here and the count assertion
    // below failed for a reason that had nothing to do with type rendering.
    const mutations = all.filter((m) => m.table === 't');
    assert.equal(mutations.length, 1);

    const wire = (await raw.query('SELECT * FROM t WHERE id = 1')).rows[0] as Record<string, string>;
    const disagreements: string[] = [];
    for (const [name] of TYPES) {
      const decoded = mutations[0]!.columns.get(`${name}_c`);
      assert.ok(decoded, `${name}: the decoder printed no column`);
      const normalised = toWireText(name, decoded);
      if (normalised !== wire[`${name}_c`]) {
        disagreements.push(
          `${name}: SELECT gives ${JSON.stringify(wire[`${name}_c`])}, ` +
            `the decoder gives ${JSON.stringify(decoded.text)} ` +
            `(normalised to ${JSON.stringify(normalised)})`,
        );
      }
    }
    assert.deepEqual(
      disagreements,
      [],
      `A type renders differently in the write-ahead log than over the wire, and \`toWireText\`\n` +
        `does not account for it. Left alone, a key of this type matches no row and the engine\n` +
        `reports an empty ChangeSet over a real write.\n\n${disagreements.join('\n')}`,
    );
  });

  it('covers the types a key can actually have', async (t) => {
    if (!reachable) return t.skip('no database with logical decoding');
    // A type that can be a primary key but is not exercised above is a gap in
    // this guard, not an absence of risk.
    const covered = new Set(TYPES.map(([n]) => n));
    const { rows } = await client.query<{ typname: string }>(
      `SELECT t.typname FROM pg_type t
        JOIN pg_opclass o ON o.opcintype = t.oid
        JOIN pg_am am ON am.oid = o.opcmethod AND am.amname = 'btree'
       WHERE t.typtype IN ('b', 'r', 'e') AND t.typnamespace = 'pg_catalog'::regnamespace
         AND t.typname NOT LIKE '\\_%'
       GROUP BY t.typname`,
    );
    const indexable = rows.map((r) => r.typname);
    const missing = indexable.filter((n) => !covered.has(n));
    // Informational rather than fatal: the catalogue lists internal types no
    // application uses. Printed so the list can be reviewed when it grows.
    if (missing.length > 0) console.log(`\n    btree-indexable types not covered: ${missing.join(', ')}\n`);
    assert.ok(indexable.length > 10, 'the catalogue query should find real types');
  });
});

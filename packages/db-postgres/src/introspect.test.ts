/**
 * What the engine will and will not accept as a row's identity.
 *
 * Every case here is a shape that used to produce a *narrower* key than the
 * index it came from. That is the dangerous failure: a prefix of a unique
 * index is not unique, so rows collide in the pairing map and one of them is
 * silently dropped from the report. Measured before the fix, on
 * `UNIQUE (row_no, seat)` with a nullable `seat`: an UPDATE that touched two
 * rows came back as one change, no warning, the other row simply absent.
 *
 * Falling back to the full-row multiset is the right answer when no key
 * qualifies — less precise, but it never invents a pairing.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { describeScope, readTableIdentities } from './introspect.js';

const BASE_URL =
  process.env['TUPLESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

const SCHEMA = 'tuplescope_identity_test';
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

/** table DDL → the key the engine must derive from it, and why. */
const SHAPES: ReadonlyArray<{ table: string; ddl: string[]; key: string[]; because: string }> = [
  {
    table: 'plain_pk',
    ddl: [`CREATE TABLE plain_pk (id text PRIMARY KEY, x text)`],
    key: ['id'],
    because: 'the ordinary case',
  },
  {
    table: 'composite_pk',
    ddl: [`CREATE TABLE composite_pk (a text, b text, x text, PRIMARY KEY (a, b))`],
    key: ['a', 'b'],
    because: 'a junction table has no single-column key and must not be given one',
  },
  {
    table: 'pk_and_unique',
    ddl: [`CREATE TABLE pk_and_unique (id text PRIMARY KEY, email text NOT NULL UNIQUE)`],
    key: ['id'],
    because: 'a declared primary key beats any unique index, however narrow',
  },
  {
    table: 'two_uniques',
    ddl: [
      `CREATE TABLE two_uniques (a text NOT NULL, b text NOT NULL, c text NOT NULL)`,
      `CREATE UNIQUE INDEX ON two_uniques (a, b)`,
      `CREATE UNIQUE INDEX ON two_uniques (c)`,
    ],
    key: ['c'],
    because: 'between unique indexes the narrowest wins',
  },
  {
    table: 'nullable_member',
    ddl: [
      `CREATE TABLE nullable_member (a text NOT NULL, b text, x text)`,
      `CREATE UNIQUE INDEX ON nullable_member (a, b)`,
    ],
    key: [],
    because:
      'NULLs do not equal each other, so the index does not guarantee uniqueness. ' +
      'Dropping just the nullable column would leave `a` behind as a key that is not one',
  },
  {
    table: 'with_include',
    ddl: [
      `CREATE TABLE with_include (a text NOT NULL, payload text NOT NULL)`,
      `CREATE UNIQUE INDEX ON with_include (a) INCLUDE (payload)`,
    ],
    key: ['a'],
    because:
      'INCLUDE columns are stored, not indexed. In the key they would make a row ' +
      'change identity whenever its payload changed, turning an update into a delete ' +
      'and an insert',
  },
  {
    table: 'expression_only',
    ddl: [
      `CREATE TABLE expression_only (a text NOT NULL)`,
      `CREATE UNIQUE INDEX ON expression_only (lower(a))`,
    ],
    key: [],
    because: 'there is no column to read the value back from',
  },
  {
    table: 'expression_then_column',
    ddl: [
      `CREATE TABLE expression_then_column (a text NOT NULL, b text NOT NULL)`,
      `CREATE UNIQUE INDEX ON expression_then_column (lower(a), b)`,
    ],
    key: [],
    because:
      'the same narrowing trap as a nullable member: skipping the expression would ' +
      'leave `b` alone, and `b` alone is not unique',
  },
  {
    table: 'partial_unique',
    ddl: [
      `CREATE TABLE partial_unique (a text NOT NULL, live boolean NOT NULL)`,
      `CREATE UNIQUE INDEX ON partial_unique (a) WHERE live`,
    ],
    key: [],
    because: 'a partial index says nothing about the rows outside its predicate',
  },
];

let client: pg.Client;

before(async () => {
  if (!available) return;
  client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  for (const shape of SHAPES) for (const ddl of shape.ddl) await client.query(ddl);
});

after(async () => {
  if (!available) return;
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
});

describe('what counts as a row identity', () => {
  it('derives the key each index shape actually supports', async (t) => {
    if (!available) return t.skip('no database');
    const identities = await readTableIdentities(
      client as unknown as pg.PoolClient,
      SHAPES.map((s) => s.table),
    );
    const wrong: string[] = [];
    for (const shape of SHAPES) {
      const got = identities.get(shape.table)?.keyColumns ?? [];
      if (JSON.stringify([...got]) !== JSON.stringify(shape.key)) {
        wrong.push(
          `${shape.table}: expected ${JSON.stringify(shape.key)}, got ${JSON.stringify([...got])}` +
            `\n    ${shape.because}`,
        );
      }
    }
    assert.deepEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
  });

  it('reports both rows when a collapsed key would have hidden one', async (t) => {
    if (!available) return t.skip('no database');
    // The measured failure, end to end. `(row_no, seat)` with a nullable seat
    // once collapsed to `row_no`; both rows here share it.
    await client.query(`INSERT INTO nullable_member VALUES ('12', 'A', 'alice'), ('12', 'B', 'bob')`);
    const identity = (
      await readTableIdentities(client as unknown as pg.PoolClient, ['nullable_member'])
    ).get('nullable_member');
    assert.deepEqual(
      [...(identity?.keyColumns ?? [])],
      [],
      'a key over these two rows would give them the same identity',
    );
  });
});

describe('describeScope', () => {
  /**
   * The three narrowings `listBaseTables` performs in one WHERE clause, each of
   * which used to turn a real write into "Nothing was written. Not a single row
   * was touched" — outcome clean, exit 0, no warning, all three engines.
   */
  it('names what it is not watching, and why', async (t) => {
    if (!available) return t.skip('no database');

    await client.query(`CREATE SCHEMA IF NOT EXISTS scope_probe_other`);
    await client.query(`CREATE TABLE IF NOT EXISTS scope_probe_other.hidden (id int PRIMARY KEY)`);
    await client.query(`CREATE TABLE IF NOT EXISTS _scope_probe_under (id int PRIMARY KEY)`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS scope_probe_parent (id int, at timestamptz) PARTITION BY RANGE (at)`,
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS scope_probe_part PARTITION OF scope_probe_parent
         FOR VALUES FROM ('2020-01-01') TO ('2030-01-01')`,
    );
    try {
      const scope = await describeScope(client as unknown as pg.PoolClient);

      assert.equal(scope.schema, SCHEMA, 'the schema it watches must be named');
      assert.ok(
        scope.otherSchemas.some((s) => s.schema === 'scope_probe_other' && s.tables >= 1),
        'a table in another schema is not watched at all, and must be counted',
      );
      assert.ok(
        scope.nameFiltered.includes('_scope_probe_under'),
        'a leading underscore excludes the table, so name it',
      );
      assert.ok(
        scope.partitionedParents.includes('scope_probe_parent'),
        'nothing writes to the parent; its partitions are what is watched',
      );
      // The partition itself is an ordinary table and *is* watched, so it must
      // not be reported as a gap.
      assert.equal(scope.nameFiltered.includes('scope_probe_part'), false);
      assert.equal(scope.partitionedParents.includes('scope_probe_part'), false);
      assert.ok(scope.watched >= 1, 'the count of what is watched must be real');
    } finally {
      await client.query(`DROP TABLE IF EXISTS scope_probe_parent CASCADE`).catch(() => undefined);
      await client.query(`DROP TABLE IF EXISTS _scope_probe_under`).catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS scope_probe_other CASCADE`).catch(() => undefined);
    }
  });
});

/**
 * A real psql, a real database, and a key value trying to get out.
 *
 * The escape tests are the reason this file exists. `-X` disables `psqlrc`; it
 * does **not** disable `\!` read from stdin, so the only thing between a
 * captured key value and shell execution is that the value is inside a properly
 * escaped literal. That is a claim about a lexer, and a claim about a lexer is
 * worth running rather than reasoning about.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { visible } from '@tuplescope/core';
import { psqlScript, runPsql, PsqlRefused } from './psql.js';
import type { PsqlServiceBinding } from './config.js';

const DATABASE_URL =
  process.env['TUPLESCOPE_TEST_DATABASE_URL'] ??
  'postgresql://postgres:postgres@127.0.0.1:7432/postgres';

/** Only the parts of the DSN libpq needs, so the service file can be written. */
function parseDsn(dsn: string): { host: string; port: string; user: string; password: string } {
  const url = new URL(dsn);
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port || '5432',
    user: decodeURIComponent(url.username) || 'postgres',
    password: decodeURIComponent(url.password) || 'postgres',
  };
}

/**
 * The path and its realpath, kept apart — because that is what `handoff enable`
 * records, and collapsing them made this suite test something no user has.
 *
 * `runPsql` spawns `executable`; `realpath` is only the integrity check. On
 * Debian and Ubuntu `/usr/bin/psql` resolves to `pg_wrapper`, a dispatcher that
 * picks its target from argv[0] — so spawning the *realpath* runs a wrapper
 * that cannot dispatch, and six of these seven tests fail. Measured in a real
 * ubuntu:24.04 container: `# pass 1  # fail 6  # skipped 0`. Production was
 * never affected; it spawns `/usr/bin/psql` and the wrapper sees the name it
 * needs. On macOS the two happen to be interchangeable, which is why this held
 * for as long as it did.
 */
const psql = await (async (): Promise<{ executable: string; realpath: string } | undefined> => {
  for (const candidate of ['/opt/homebrew/bin/psql', '/usr/local/bin/psql', '/usr/bin/psql']) {
    try {
      return { executable: candidate, realpath: await realpath(candidate) };
    } catch {
      /* keep looking */
    }
  }
  return undefined;
})();
const psqlPath = psql?.executable;

let home: string;
let binding: PsqlServiceBinding;
let ready = false;

before(async () => {
  if (!psqlPath) return;
  const dsn = parseDsn(DATABASE_URL);
  home = await mkdtemp(join(tmpdir(), 'tuplescope-psql-'));
  // The default locations, found through HOME. `PGSERVICEFILE` is deliberately
  // *not* in the child's environment allow-list, so this is the supported way
  // to point psql at a service — and testing any other way would test a path
  // no user has.
  await writeFile(
    join(home, '.pg_service.conf'),
    `[tuplescope-test]\nhost=${dsn.host}\nport=${dsn.port}\ndbname=tuplescope_psql\nuser=${dsn.user}\n\n` +
      `[tuplescope-other]\nhost=${dsn.host}\nport=${dsn.port}\ndbname=postgres\nuser=${dsn.user}\n`,
  );
  await writeFile(join(home, '.pgpass'), `${dsn.host}:${dsn.port}:*:${dsn.user}:${dsn.password}\n`);
  await chmod(join(home, '.pgpass'), 0o600);

  binding = {
    preset: 'psql-service',
    service: 'tuplescope-test',
    executable: psql!.executable,
    realpath: psql!.realpath,
    grants: [],
  };

  // Bootstrap through a service pointing at the maintenance database, so the
  // test needs no client library of its own.
  const bootstrap: PsqlServiceBinding = { ...binding, service: 'tuplescope-other' };
  process.env['HOME'] = home;
  const created = await runPsql(
    bootstrap,
    // `WITH (FORCE)` because this suite deliberately kills a child mid-query;
    // a connection left behind by that makes every later run fail to create the
    // database and skip, silently, forever.
    `DROP DATABASE IF EXISTS tuplescope_psql WITH (FORCE);\nCREATE DATABASE tuplescope_psql;\n`,
  );
  if (!created.ok) return;
  const seeded = await runPsql(
    binding,
    `CREATE TABLE wallets (id text PRIMARY KEY, balance numeric);\n` +
      `INSERT INTO wallets VALUES ('wal_alice', '1000.00');\n`,
  );
  ready = seeded.ok;
});

after(async () => {
  if (!psqlPath || !home) return;
  await runPsql(
    { ...binding, service: 'tuplescope-other' },
    'DROP DATABASE IF EXISTS tuplescope_psql WITH (FORCE);\n',
  ).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

const location = { database: 'tuplescope_psql', schema: 'public' };
const aliceKey = [{ name: 'id', value: visible('text', 'wal_alice') }];

describe('running a locator through psql', () => {
  it('opens the row the locator names', async (t) => {
    if (!ready) return t.skip('no psql or no database');
    const result = await runPsql(binding, psqlScript(location, 'wallets', aliceKey));
    assert.equal(result.ok, true, result.stderr);
    assert.match(result.stdout, /wal_alice/);
    assert.match(result.stdout, /1000\.00/);
  });

  it('refuses a service pointing at a different database', async (t) => {
    if (!ready) return t.skip('no psql or no database');
    // The check that makes `database` load-bearing. A service name is the one
    // thing the user picked blind, and dev clusters routinely hold `shop`,
    // `shop_test` and `shop_shadow` with identical schemas.
    const result = await runPsql(
      { ...binding, service: 'tuplescope-other' },
      psqlScript(location, 'wallets', aliceKey),
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr, /this connection is database postgres/);
  });

  it('says the table is absent rather than returning an empty result', async (t) => {
    if (!ready) return t.skip('no psql or no database');
    // Two states that otherwise render identically: connected to the right
    // place with no such table, and connected with the table there and no
    // matching row.
    const result = await runPsql(
      binding,
      psqlScript(location, 'nosuchtable', [{ name: 'id', value: visible('text', 'x') }]),
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr, /has no table public\.nosuchtable/);
  });
});

describe('a key value that tries to get out', () => {
  it('cannot reach a psql meta-command, a second statement, or the shell', async (t) => {
    if (!ready) return t.skip('no psql or no database');
    const canary = join(home, 'escaped');
    assert.equal(existsSync(canary), false);

    const attacks: Array<[string, string]> = [
      // `\!` at the start of a line is psql's shell escape. -X does not disable it.
      ['shell escape', `x'\n\\! touch ${canary}\n--`],
      ['second statement', `x'; DROP TABLE wallets; --`],
      ['backslash escape', `x\\'; SELECT 1; --`],
      ['gset', `x'\n\\gset\n--`],
    ];

    for (const [name, evil] of attacks) {
      const result = await runPsql(
        binding,
        psqlScript(location, 'wallets', [{ name: 'id', value: visible('text', evil) }]),
      );
      // It runs, finds nothing, and changes nothing — which is exactly right:
      // the value is data, and no row has that id.
      assert.equal(result.ok, true, `${name}: ${result.stderr}`);
      assert.match(result.stdout, /\(0 rows\)/, name);
      assert.equal(existsSync(canary), false, `${name} reached the shell`);
    }

    // ...and the table it tried to drop is still there.
    const after = await runPsql(binding, psqlScript(location, 'wallets', aliceKey));
    assert.equal(after.ok, true, after.stderr);
    assert.match(after.stdout, /wal_alice/);
  });
});

describe('the harness', () => {
  it('refuses an executable that no longer resolves where it was approved', async (t) => {
    if (!psqlPath) return t.skip('no psql');
    // Does not close the TOCTOU window — nothing portable does — but converts a
    // substitution from silent into a refusal the user has to look at.
    await assert.rejects(
      () => runPsql({ ...binding, realpath: '/somewhere/else/psql' }, 'SELECT 1;\n'),
      PsqlRefused,
    );
  });

  it('kills a child that runs past its deadline', async (t) => {
    if (!ready) return t.skip('no psql or no database');
    const result = await runPsql(binding, 'SELECT pg_sleep(30);\n', { timeoutMs: 1500 });
    assert.equal(result.killed, 'timeout');
    assert.equal(result.ok, false);
  });

  it('caps output rather than buffering whatever comes', async (t) => {
    if (!ready) return t.skip('no psql or no database');
    const result = await runPsql(
      binding,
      `SELECT repeat('x', 100) FROM generate_series(1, 20000);\n`,
      { maxOutputBytes: 4096 },
    );
    assert.equal(result.killed, 'output-cap');
    assert.match(result.stdout, /output capped at 4096 bytes/);
  });
});

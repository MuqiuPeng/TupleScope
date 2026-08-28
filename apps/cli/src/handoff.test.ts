/**
 * Which workspace a grant is recorded against.
 *
 * The bug this exists for: `handoff enable` keyed the grant on `process.cwd()`
 * while the runtime checks it against the workspace's own `configDir`. They are
 * the same directory right up until someone runs
 * `statescope handoff enable --config examples/shopfront/statescope.yaml` from
 * the repository root — and then the grant lands on the repository root while
 * the thing that checks it goes on refusing, with nothing anywhere saying why.
 * A grant that names a different directory from the one that checks it is a
 * grant that silently does nothing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { commandHandoff } from './handoff.js';

let home: string;
let elsewhere: string;
let cwd: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'statescope-cli-handoff-'));
  elsewhere = join(home, 'a-workspace');
  await mkdir(join(elsewhere, 'scenarios'), { recursive: true });
  await writeFile(
    join(elsewhere, 'statescope.yaml'),
    'name: Elsewhere\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
      'database:\n  connectionString: postgresql://postgres:postgres@127.0.0.1:1/x\n',
  );
  cwd = process.cwd();
  process.env['HOME'] = home;
});

after(async () => {
  process.chdir(cwd);
  await rm(home, { recursive: true, force: true });
});

async function grantsFor(alias: string): Promise<string[]> {
  const text = await readFile(join(home, '.statescope', 'handoff.json'), 'utf8');
  const config = JSON.parse(text) as {
    bindings: Record<string, { grants: { workspace: string }[] }>;
  };
  return (config.bindings[alias]?.grants ?? []).map((g) => g.workspace);
}

describe('statescope handoff enable', () => {
  it('records the grant against the workspace --config names, not the shell', async () => {
    // Run from somewhere that is deliberately *not* the workspace.
    process.chdir(home);
    const code = await commandHandoff(['enable', 'adminer-url'], {
      config: join(elsewhere, 'statescope.yaml'),
      as: 'adminer',
      origin: 'http://127.0.0.1:8080',
      server: 'db:5432',
      username: 'postgres',
    });
    assert.equal(code, 0);
    assert.deepEqual(await grantsFor('adminer'), [await realpath(elsewhere)]);
  });

  it('revokes the same workspace the enable named', async () => {
    process.chdir(home);
    const code = await commandHandoff(['disable', 'adminer'], {
      config: join(elsewhere, 'statescope.yaml'),
    });
    assert.equal(code, 0);
    assert.deepEqual(await grantsFor('adminer'), []);
  });

  it('falls back to the working directory when there is no workspace to find', async () => {
    // `handoff list` is run from anywhere, and must not fail for want of a
    // statescope.yaml.
    process.chdir(home);
    const code = await commandHandoff(['list'], {});
    assert.equal(code, 0);
  });
});

describe('the address hint', () => {
  /** Runs `enable` with `--server` missing and returns what it wrote to stderr. */
  async function usageFor(dsn: string): Promise<string> {
    const dir = await mkdtemp(join(home, 'ws-'));
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await writeFile(
      join(dir, 'statescope.yaml'),
      `name: Hinted\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n` +
        `database:\n  connectionString: ${dsn}\n`,
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      await commandHandoff(['enable', 'adminer-url'], {
        config: join(dir, 'statescope.yaml'),
        as: 'adminer',
      });
    } finally {
      (process.stderr as { write: unknown }).write = original;
    }
    return written.join('');
  }

  it('never prints the password, which is the whole risk of quoting a DSN', async () => {
    // A usage message is exactly the kind of text that gets pasted into a chat
    // or an issue. Host and port are what the reader needs; the credential is
    // not, and there is no version of this hint worth leaking one for.
    const usage = await usageFor('postgresql://dbuser:SUPERSECRET_hunter2@db.internal:6543/app');
    assert.doesNotMatch(usage, /SUPERSECRET/);
    assert.match(usage, /db\.internal:6543/);
    assert.match(usage, /dbuser/);
  });

  it('offers the container address only when the DSN is loopback', async () => {
    // Loopback means *this machine*, and inside a container that is the
    // container — so there really are two candidates and the user has to pick.
    const local = await usageFor('postgresql://postgres:pw@127.0.0.1:7432/app');
    assert.match(local, /host\.docker\.internal:7432/);

    // A real hostname resolves the same from inside a container as outside it.
    // Offering a second candidate there would be inventing one.
    const remote = await usageFor('postgresql://postgres:pw@db.internal:6543/app');
    assert.doesNotMatch(remote, /host\.docker\.internal/);
  });

  it('falls back to the generic message when the DSN cannot be read', async () => {
    // An unresolved `${secret:…}` is not a URL. A wrong hint would be worse
    // than none.
    const usage = await usageFor('${secret:database_url}');
    assert.match(usage, /--server/);
    assert.doesNotMatch(usage, /This workspace reaches PostgreSQL/);
  });
});

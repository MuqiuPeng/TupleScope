/**
 * That a workspace opens the same way from every surface.
 *
 * Found by pointing the UI at a real service: `tuplescope run` worked against a
 * workspace whose password was in the keychain, and `pnpm start` on the same
 * file refused to start. The runtime and MCP had each loaded the file and
 * opened the session with nothing in between. `assertResolved` caught it at
 * startup, which is what it is for — but a sentence at startup is a bug report,
 * and the fix is that the omission no longer compiles.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { namespaceFor, Secret, type SecretStore } from '@tuplescope/secrets';
import { loadWorkspaceConfig } from './config.js';
import { loadWorkspace } from './open.js';
import { openWorkspace } from './session.js';

const fakeStore = (values: Record<string, string>): SecretStore => ({
  description: 'a fake',
  async get(id) {
    return values[id] === undefined ? undefined : new Secret(values[id]!, id);
  },
  async has(id) {
    return values[id] !== undefined;
  },
  async set() {},
  async delete() {
    return false;
  },
  async list() {
    return [];
  },
});

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspaceFile(connectionString: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tuplescope-open-'));
  dirs.push(dir);
  const file = join(dir, 'tuplescope.yaml');
  await writeFile(
    file,
    `name: Shop\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\ndatabase:\n  connectionString: ${connectionString}\n`,
  );
  return file;
}

const WITH_SECRET = 'postgresql://app:${secret:db_password}@localhost/shop';

describe('loadWorkspace', () => {
  it('turns a reference into its value, and can take the value back out', async () => {
    const file = await workspaceFile(WITH_SECRET);
    const { config, scrub } = await loadWorkspace({
      configPath: file,
      openStore: async () => ({ store: fakeStore({ db_password: 'hunter2hunter2' }) }),
    });
    assert.equal(config.database.connectionString, 'postgresql://app:hunter2hunter2@localhost/shop');
    // A driver reports an authentication failure with the whole connection
    // string inline. That text was not formatted here, so this is the backstop.
    const leaked = scrub('password authentication failed: postgresql://app:hunter2hunter2@localhost/shop');
    assert.doesNotMatch(leaked, /hunter2hunter2/);
  });

  it('opens the store under the workspace’s own slot', async () => {
    // Two checkouts that both refer to `db_password` must not share a value.
    const file = await workspaceFile(WITH_SECRET);
    let asked: string | undefined;
    await loadWorkspace({
      configPath: file,
      openStore: async (namespace) => {
        asked = namespace;
        return { store: fakeStore({ db_password: 'hunter2hunter2' }) };
      },
    });
    assert.equal(asked, namespaceFor('Shop'));
  });

  it('never opens a store for a workspace that refers to no secret', async () => {
    // Opening the keychain can prompt. A workspace with nothing in it must not.
    const file = await workspaceFile('postgresql://app@localhost/shop');
    const { config } = await loadWorkspace({
      configPath: file,
      openStore: async () => {
        throw new Error('the store was opened for nothing');
      },
    });
    assert.equal(config.database.connectionString, 'postgresql://app@localhost/shop');
  });

  it('says why there is no store rather than substituting one', async () => {
    const file = await workspaceFile(WITH_SECRET);
    await assert.rejects(
      loadWorkspace({
        configPath: file,
        openStore: async () => ({
          store: undefined,
          reason: 'there is no credential store for plan9. Use environment variables with `${VAR}`.',
        }),
      }),
      (error: Error) => /db_password/.test(error.message) && /plan9/.test(error.message),
    );
  });
});

describe('what openWorkspace accepts', () => {
  it('is a config that came through resolution, and nothing else', async () => {
    // The fix, at the type level. A config straight off disk still holds
    // references as names; a session opened over it would send `${secret:…}`
    // to the API as those characters. So `openWorkspace` takes only what
    // `loadWorkspace`/`resolveWorkspaceSecrets` return, and the runtime's old
    // shape — load, then open — does not compile.
    const file = await workspaceFile(WITH_SECRET);
    const loaded = await loadWorkspaceConfig({ configPath: file });
    // @ts-expect-error — a config whose credentials are still names cannot open a session
    const skipped = () => openWorkspace(loaded);
    // Never called: the runtime guard behind the type would throw. The line
    // above is the assertion; this only keeps the binding used.
    assert.equal(typeof skipped, 'function');
  });
});

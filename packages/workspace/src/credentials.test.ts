/**
 * The step where a reference becomes a credential, and the guard that catches
 * a run which skipped it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { secretMarker, Secret, type SecretStore } from '@statescope/secrets';
import { assertResolved, resolveWorkspaceSecrets, secretsReferencedBy } from './credentials.js';

/**
 * A config carries *markers*, not the original `${secret:…}` text.
 *
 * The load pass replaces references with a marker bearing a nonce minted for
 * that pass, precisely so that this pass cannot mistake an environment
 * variable's value — or text the `$${` escape was protecting — for a reference.
 * These tests build what that pass actually emits.
 */
const NONCE = 'testnonce0123456789abcdef01234567';
const ref = (name: string) => secretMarker(NONCE, name);
import type { ResolvedWorkspaceConfig } from './config.js';

const store: SecretStore = {
  description: 'a fake',
  async get(id) {
    const values: Record<string, string> = { alice_token: 'cus_alice_9f3a', db_password: 'hunter2hunter2' };
    return values[id] === undefined ? undefined : new Secret(values[id]!, id);
  },
  async has(id) {
    return (await this.get(id)) !== undefined;
  },
  async set() {},
  async delete() {
    return false;
  },
  async list() {
    return [];
  },
};

const base = (over: Partial<ResolvedWorkspaceConfig> = {}): ResolvedWorkspaceConfig =>
  ({
    name: 'Demo',
    baseUrl: 'http://127.0.0.1:7421',
    database: { connectionString: 'postgresql://app@localhost/x' },
    scenariosDir: '/repo/scenarios',
    configFile: '/repo/statescope.yaml',
    configDir: '/repo',
    ...over,
  }) as ResolvedWorkspaceConfig;

describe('resolving a workspace', () => {
  it('finds references anywhere a string can be, not in a list of known fields', () => {
    // A credential can go wherever a string can. A hand-maintained list of
    // fields that may hold secrets is out of date the first time one is added.
    const config = base({
      database: { connectionString: `postgresql://app:${ref('db_password')}@localhost/x` },
      identities: [{ id: 'alice', header: { name: 'authorization', value: `Bearer ${ref('alice_token')}` } }],
      resetUrl: `http://x/r?t=${ref('alice_token')}`,
    });
    assert.deepEqual(secretsReferencedBy(config, NONCE), ['alice_token', 'db_password']);
  });

  it('substitutes the values and reports which it used', async () => {
    const { config, secrets } = await resolveWorkspaceSecrets(
      base({
        database: { connectionString: `postgresql://app:${ref('db_password')}@localhost/x` },
        identities: [
          { id: 'alice', header: { name: 'authorization', value: `Bearer ${ref('alice_token')}` } },
        ],
      }),
      { store, env: {}, nonce: NONCE },
    );
    assert.equal(config.database.connectionString, 'postgresql://app:hunter2hunter2@localhost/x');
    assert.equal(config.identities?.[0]?.header?.value, 'Bearer cus_alice_9f3a');
    assert.deepEqual(secrets.map((s) => s.name).sort(), ['alice_token', 'db_password']);
  });

  it('scrubs the values back out of text somebody else formatted', async () => {
    // The only defence against a driver error with the connection string inline.
    const { scrub } = await resolveWorkspaceSecrets(
      base({ database: { connectionString: `postgresql://app:${ref('db_password')}@localhost/x` } }),
      { store, env: {}, nonce: NONCE },
    );
    const message = 'FATAL: password authentication failed for "postgresql://app:hunter2hunter2@localhost/x"';
    assert.doesNotMatch(scrub(message), /hunter2hunter2/);
    assert.match(scrub(message), /\[secret db_password\]/);
  });

  it('names the field when a referenced secret is not configured', async () => {
    await assert.rejects(
      () =>
        resolveWorkspaceSecrets(base({ resetUrl: `http://x/?t=${ref('never_set')}` }), { store, env: {}, nonce: NONCE }),
      /`never_set` is not configured.*referenced by `resetUrl`/s,
    );
  });

  it('says why there is no store rather than just "not configured"', async () => {
    await assert.rejects(
      () =>
        resolveWorkspaceSecrets(base({ resetUrl: `http://x/?t=${ref('a')}` }), { env: {}, storeUnavailable: 'No keyring is running here.', nonce: NONCE }),
      /no secret store is available.*No keyring is running here/s,
    );
  });

  it('leaves a config with no references untouched', async () => {
    const config = base();
    const out = await resolveWorkspaceSecrets(config, { env: {}, nonce: NONCE });
    assert.deepEqual(out.config, config);
    assert.deepEqual(out.secrets, []);
  });
});

describe('the guard against skipping resolution', () => {
  it('refuses a config that still holds a reference, and names the field', () => {
    // Unresolved, the marker would be sent to the API and the failure would
    // read as an authentication problem rather than as a missing step.
    assert.throws(
      () =>
        assertResolved(
          base({
            identities: [
              { id: 'alice', header: { name: 'authorization', value: `Bearer ${ref('alice_token')}` } },
            ],
          }),
          NONCE,
        ),
      /reached the runtime unresolved: identities\.0\.header\.value/,
    );
  });

  it('passes a config that was resolved', () => {
    assert.doesNotThrow(() => assertResolved(base(), NONCE));
  });
});

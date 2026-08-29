/**
 * The lanes must not cross. Most of these check a refusal, because the failure
 * that matters is a credential arriving from somewhere the file did not say.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONTEXT, resolveTemplate, secretIdFor, type CredentialContext } from './resolve.js';
import { Secret } from './secret.js';
import type { SecretId, SecretStore, StoredSecret } from './store.js';

function fakeStore(entries: Record<string, string>): SecretStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    description: 'a fake',
    async get(id: SecretId) {
      reads.push(id);
      const value = entries[id];
      return value === undefined ? undefined : new Secret(value, id);
    },
    async has(id: SecretId) {
      return entries[id] !== undefined;
    },
    async set() {},
    async delete() {
      return false;
    },
    async list(): Promise<ReadonlyArray<StoredSecret>> {
      return Object.keys(entries).map((id) => ({ id }));
    },
  };
}

const where = '`identities[0].header.value`';

describe('resolving a value', () => {
  it('passes a literal through', async () => {
    const { value, secrets } = await resolveTemplate('Bearer cus_alice', { env: {}, where });
    assert.equal(value, 'Bearer cus_alice');
    assert.deepEqual(secrets, []);
  });

  it('reads an environment variable, and its default when unset', async () => {
    assert.equal((await resolveTemplate('${T}', { env: { T: 'v' }, where })).value, 'v');
    assert.equal((await resolveTemplate('${T:-d}', { env: {}, where })).value, 'd');
  });

  it('reads a secret from the store and reports which it used', async () => {
    const store = fakeStore({ alice_token: 'cus_alice_9f3a' });
    const { value, secrets } = await resolveTemplate('Bearer ${secret:alice_token}', {
      env: {},
      store,
      where,
    });
    assert.equal(value, 'Bearer cus_alice_9f3a');
    assert.equal(secrets.length, 1);
    assert.equal(secrets[0]!.name, 'alice_token');
  });

  it('composes several references in one string', async () => {
    const store = fakeStore({ db_password: 'hunter2hunter2' });
    const { value } = await resolveTemplate(
      'postgresql://${DB_USER}:${secret:db_password}@localhost/${DB:-app}',
      { env: { DB_USER: 'svc' }, store, where },
    );
    assert.equal(value, 'postgresql://svc:hunter2hunter2@localhost/app');
  });
});

describe('the lanes do not cross', () => {
  it('never lets ${secret:x} fall back to environment variable x', async () => {
    // The boundary the whole model rests on. With this hole open, a credential
    // could arrive from the environment on one machine and the keychain on
    // another, and nobody could say which — or notice when it changed.
    const store = fakeStore({});
    await assert.rejects(
      () =>
        resolveTemplate('${secret:api_token}', {
          env: { api_token: 'FROM_ENV', API_TOKEN: 'FROM_ENV_UPPER' },
          store,
          where,
        }),
      /is not configured/,
    );
  });

  it('never lets ${VAR} read the store', async () => {
    const store = fakeStore({ API_TOKEN: 'FROM_STORE', api_token: 'FROM_STORE' });
    await assert.rejects(() => resolveTemplate('${API_TOKEN}', { env: {}, store, where }), /is not set/);
    assert.deepEqual(store.reads, [], 'the store should not even be consulted');
  });

  it('says why, and what to do, when no store is available at all', async () => {
    await assert.rejects(
      () =>
        resolveTemplate('${secret:api_token}', {
          env: {},
          where,
          storeUnavailable: 'No keyring is running on this machine.',
        }),
      (e: unknown) => {
        const message = (e as Error).message;
        assert.match(message, /no secret store is available/);
        assert.match(message, /No keyring is running/);
        // ...and it must not suggest the boundary is negotiable.
        assert.match(message, /will not fall back to an\s+environment variable/);
        assert.match(message, /write\s+`\$\{SOME_VAR\}` instead/);
        return true;
      },
    );
  });
});

describe('the reserved profile indirection', () => {
  it('resolves a logical name to itself when nothing binds it', () => {
    assert.equal(secretIdFor('customer_token', DEFAULT_CONTEXT), 'customer_token');
  });

  it('follows a binding to a different stored id', async () => {
    // What profiles will be: one shared file says `${secret:customer_token}`,
    // and each person's context points it at their own credential.
    const alice: CredentialContext = {
      profile: 'alice',
      bindings: { customer_token: 'alice_customer_token' },
    };
    const store = fakeStore({
      alice_customer_token: 'cus_alice',
      bob_customer_token: 'cus_bob',
      customer_token: 'SHOULD_NOT_BE_READ',
    });
    const { value } = await resolveTemplate('${secret:customer_token}', {
      env: {},
      store,
      context: alice,
      where,
    });
    assert.equal(value, 'cus_alice');
    assert.deepEqual(store.reads, ['alice_customer_token']);
  });

  it('names the stored id, not just the logical one, when a binding points nowhere', async () => {
    // Otherwise the advice is `tuplescope secret set customer_token`, which
    // would set the wrong thing and appear to fix nothing.
    const store = fakeStore({});
    await assert.rejects(
      () =>
        resolveTemplate('${secret:customer_token}', {
          env: {},
          store,
          context: { profile: 'alice', bindings: { customer_token: 'alice_customer_token' } },
          where,
        }),
      /resolves to the secret `alice_customer_token`.*secret set alice_customer_token/s,
    );
  });

  it('lets a run-scoped override win over everything', async () => {
    const store = fakeStore({ t: 'FROM_STORE' });
    const { value } = await resolveTemplate('${secret:t}', {
      env: {},
      store,
      context: { bindings: {}, overrides: { t: 'FOR_THIS_RUN' } },
      where,
    });
    assert.equal(value, 'FOR_THIS_RUN');
    assert.deepEqual(store.reads, []);
  });
});

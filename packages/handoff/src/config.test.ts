/**
 * What the trust file will and will not accept.
 *
 * Everything here becomes an address a browser opens or a program that runs, so
 * every case is a refusal that has to hold. The validator never coerces: a
 * validator that "fixes" a malformed value decides, on the user's behalf, what
 * they meant.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertOrigin,
  grantKey,
  HandoffConfigError,
  HANDOFF_POLICY_VERSION,
  isGranted,
  parseHandoffConfig,
  type Binding,
} from './config.js';

const adminer = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  bindings: {
    adminer: {
      preset: 'adminer-url',
      origin: 'http://127.0.0.1:7442',
      server: '172.17.0.3:5432',
      username: 'postgres',
      grants: [],
      ...over,
    },
  },
});

describe('an adminer binding', () => {
  it('keeps the three addresses apart', () => {
    // The measurement this field exists for: the origin the browser opens, the
    // host TupleScope's own DSN names, and the host Adminer reaches PostgreSQL
    // on are three different things in any Compose stack, and only the user
    // knows the third.
    const config = parseHandoffConfig(adminer());
    const binding = config.bindings['adminer'];
    assert.equal(binding?.preset, 'adminer-url');
    if (binding?.preset !== 'adminer-url') return;
    assert.equal(binding.origin, 'http://127.0.0.1:7442');
    assert.equal(binding.server, '172.17.0.3:5432');
    assert.equal(binding.username, 'postgres');
  });

  it('refuses an origin carrying a path or a query', () => {
    // A stored path would be spliced ahead of the locator's parameters, which
    // is a way to make the final URL mean something the confirmation never
    // showed.
    assert.throws(() => parseHandoffConfig(adminer({ origin: 'http://127.0.0.1:7442/adminer' })), HandoffConfigError);
    assert.throws(() => parseHandoffConfig(adminer({ origin: 'http://127.0.0.1:7442/?x=1' })), HandoffConfigError);
  });

  it('refuses a non-loopback origin unless it was asked for explicitly', () => {
    assert.throws(() => parseHandoffConfig(adminer({ origin: 'http://db.example.com' })), /not loopback/);
    assert.doesNotThrow(() =>
      parseHandoffConfig(adminer({ origin: 'http://db.example.com' }), { allowRemote: true }),
    );
  });

  it('refuses a username with a character the confirmation could not show', () => {
    // The user is shown the exact string that will be opened. A control
    // character in it is invisible in the one place they get to check.
    for (const username of ['a\u0000b', 'a\nb', 'a\u001bb', 'a\u007fb', '']) {
      assert.throws(() => parseHandoffConfig(adminer({ username })), HandoffConfigError, JSON.stringify(username));
    }
  });

  it('accepts the role names people actually have', () => {
    // The obvious pattern for the rule above — `[^ -/?#&=]` — reads as "not
    // these six" and means "not anything from space to slash". It rejected
    // `user.name`. The URL is built with URLSearchParams, so a delimiter in a
    // role name is encoded, not spliced.
    for (const username of ['postgres', 'read_only', 'user.name', 'svc-web', 'app+ro', 'Ünïcødé']) {
      assert.doesNotThrow(() => parseHandoffConfig(adminer({ username })), username);
    }
  });

  it('refuses a server that is not a host and port', () => {
    for (const server of ['host:notaport', 'ho st', 'http://host', '']) {
      assert.throws(() => parseHandoffConfig(adminer({ server })), HandoffConfigError, server);
    }
  });
});

describe('the file as a whole', () => {
  it('refuses a version it does not write', () => {
    assert.throws(() => parseHandoffConfig({ v: 2, bindings: {} }), /version 2/);
  });

  it('refuses an unknown preset rather than ignoring it', () => {
    // Ignoring leaves the alias unbound, which reads to the user as "I never
    // set that up" when what happened is that their setup was discarded.
    assert.throws(
      () => parseHandoffConfig({ v: 1, bindings: { x: { preset: 'run-anything', grants: [] } } }),
      /does not know/,
    );
  });

  it('refuses an alias that is not a plain name', () => {
    assert.throws(() => parseHandoffConfig({ v: 1, bindings: { 'Bad Alias': {} } }), HandoffConfigError);
  });

  it('refuses a psql binding whose executable is not absolute', () => {
    assert.throws(
      () =>
        parseHandoffConfig({
          v: 1,
          bindings: {
            p: { preset: 'psql-service', service: 'shop', executable: 'psql', realpath: '/x', grants: [] },
          },
        }),
      /absolute path/,
    );
  });
});

describe('an origin on its own', () => {
  it('accepts loopback in each spelling', () => {
    for (const origin of ['http://localhost:8080', 'http://127.0.0.1:8080', 'https://[::1]:8443']) {
      assert.doesNotThrow(() => assertOrigin(origin, false), origin);
    }
  });
});

describe('a grant', () => {
  const binding = (grants: Binding['grants']): Binding => ({
    preset: 'adminer-url',
    origin: 'http://127.0.0.1:7442',
    server: 'db:5432',
    username: 'postgres',
    grants,
  });

  it('applies to the workspace it was given for and no other', () => {
    const b = binding([
      { workspace: '/home/me/shop', approvedAt: '', approvedBy: '', policyVersion: HANDOFF_POLICY_VERSION },
    ]);
    assert.equal(isGranted(b, '/home/me/shop'), true);
    assert.equal(isGranted(b, '/home/me/other'), false);
  });

  it('lapses when the policy version moves', () => {
    // Widening what a preset may do must re-ask rather than inherit an approval
    // given for something narrower.
    const b = binding([
      { workspace: '/home/me/shop', approvedAt: '', approvedBy: '', policyVersion: HANDOFF_POLICY_VERSION - 1 },
    ]);
    assert.equal(isGranted(b, '/home/me/shop'), false);
  });

  it('is keyed on everything that changes what would happen', () => {
    const a = binding([]);
    const moved = { ...a, server: 'other:5432' } as Binding;
    const renamed = { ...a, username: 'readonly' } as Binding;
    assert.notEqual(grantKey('adminer', a, '/w'), grantKey('adminer', moved, '/w'));
    assert.notEqual(grantKey('adminer', a, '/w'), grantKey('adminer', renamed, '/w'));
    assert.notEqual(grantKey('adminer', a, '/w'), grantKey('adminer', a, '/other'));
    assert.notEqual(grantKey('adminer', a, '/w'), grantKey('other', a, '/w'));
    // ...and stable when nothing that matters changed.
    assert.equal(grantKey('adminer', a, '/w'), grantKey('adminer', binding([]), '/w'));
  });
});

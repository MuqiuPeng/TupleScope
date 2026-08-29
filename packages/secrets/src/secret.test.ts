import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import { redact, Secret } from './secret.js';

describe('holding a resolved secret', () => {
  const token = new Secret('cus_alice_9f3a2b', 'alice_token');

  it('yields a placeholder through every accidental path', () => {
    assert.equal(`${token}`, '[secret alice_token]');
    assert.equal(String(token), '[secret alice_token]');
    assert.equal(JSON.stringify(token), '"[secret alice_token]"');
    assert.equal(JSON.stringify({ header: token }), '{"header":"[secret alice_token]"}');
    assert.equal(inspect(token), '[secret alice_token]');
    assert.match(inspect({ nested: { deep: token } }), /\[secret alice_token\]/);
  });

  it('never shows the value in any of them', () => {
    const everywhere = [
      `${token}`,
      JSON.stringify({ a: token }),
      inspect({ a: token }, { depth: null }),
      inspect([token]),
      // The one that catches a private field leaking through inspect's internals.
      inspect(token, { showHidden: true }),
    ].join('|');
    assert.doesNotMatch(everywhere, /cus_alice_9f3a2b/);
  });

  it('gives the value only when asked by name', () => {
    assert.equal(token.reveal(), 'cus_alice_9f3a2b');
  });

  it('reports its length without revealing it', () => {
    assert.equal(token.length, 16);
  });
});

describe('redacting text somebody else formatted', () => {
  const secrets = [new Secret('hunter2hunter2', 'db_password'), new Secret('cus_alice_9f3a2b', 'alice_token')];

  it('replaces a value inlined in a connection string', () => {
    const message = 'password authentication failed for "postgresql://app:hunter2hunter2@db/x"';
    const clean = redact(message, secrets);
    assert.doesNotMatch(clean, /hunter2hunter2/);
    assert.match(clean, /\[secret db_password\]/);
  });

  it('replaces every occurrence, not just the first', () => {
    const clean = redact('a hunter2hunter2 b hunter2hunter2', secrets);
    assert.equal(clean.match(/\[secret db_password\]/g)?.length, 2);
  });

  it('leaves a value short enough to be a coincidence alone', () => {
    // Redacting `ok` out of every message would corrupt more than it protects.
    const clean = redact('everything is ok', [new Secret('ok', 'tiny')]);
    assert.equal(clean, 'everything is ok');
  });

  it('does nothing when no secret appears', () => {
    assert.equal(redact('nothing sensitive here', secrets), 'nothing sensitive here');
  });
});

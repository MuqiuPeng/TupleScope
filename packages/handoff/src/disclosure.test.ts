/**
 * What the disclosures say, sentence by sentence.
 *
 * Two claims were measured false in round 3. `firstUse` told the reader an
 * alias "is a name this repository chose", when nothing in a repository names,
 * creates or enables one; the runtime and the page had already stopped saying
 * it. And a binding enabled with `--i-know-this-is-not-local` was promised a
 * warning "every time it is used", while its standing line and first-use text
 * read exactly like a loopback binding's.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adminerDisclosure, remoteBanner } from './adminer.js';
import type { AdminerBinding, PsqlServiceBinding } from './config.js';
import { psqlDisclosure } from './psql.js';

const local: AdminerBinding = {
  preset: 'adminer-url',
  origin: 'http://127.0.0.1:8080',
  server: 'db:5432',
  username: 'postgres',
  grants: [],
};
const remote: AdminerBinding = { ...local, origin: 'https://adminer.example.com' };
const psql: PsqlServiceBinding = {
  preset: 'psql-service',
  service: 'dev',
  executable: '/usr/bin/psql',
  realpath: '/usr/bin/psql',
  grants: [],
};

describe('first use', () => {
  const texts = {
    adminer: adminerDisclosure(local).firstUse('http://127.0.0.1:8080/?pgsql=db', 'dev-adminer', []),
    psql: psqlDisclosure(psql).firstUse('SELECT 1;\n', 'dev-psql', []),
  };
  for (const [name, text] of Object.entries(texts)) {
    it(`${name}: does not say a repository chose the alias`, () => {
      assert.doesNotMatch(text, /repository chose/);
      assert.doesNotMatch(text, /name this repository/);
    });

    it(`${name}: says what is true, that it is bound here and not enabled for this workspace`, () => {
      assert.match(text, /is bound on this machine, but not enabled for this workspace\. Enable it yourself, once:/);
    });
  }
});

describe('a non-loopback binding', () => {
  it('carries its banner in the standing line', () => {
    const standing = adminerDisclosure(remote).standing;
    assert.match(standing, /adminer\.example\.com is not loopback/);
    assert.match(standing, /DNS moves under a stable name/);
  });

  it('carries it in the first-use text too', () => {
    const text = adminerDisclosure(remote).firstUse('https://adminer.example.com/?pgsql=db', 'far', []);
    assert.match(text, /⚠ adminer\.example\.com is not loopback/);
  });

  it('is the only kind that does', () => {
    assert.equal(remoteBanner(local), null);
    assert.equal(remoteBanner({ ...local, origin: 'http://localhost:8080' }), null);
    assert.equal(remoteBanner(psql), null);
    assert.doesNotMatch(adminerDisclosure(local).standing, /not loopback/);
    assert.doesNotMatch(adminerDisclosure(local).firstUse('u', 'a', []), /not loopback/);
  });
});

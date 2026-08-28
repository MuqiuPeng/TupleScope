/**
 * The grammar is a security boundary, so the tests are mostly about what it
 * refuses. A reference that fails to parse into *something recognised* used to
 * survive as literal text and be sent to the API verbatim.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLiteral, parseTemplate, ReferenceSyntaxError, secretsIn } from './reference.js';
import { namespaceFor, NAMESPACE, qualify, unqualify } from './store.js';

const parse = (s: string) => parseTemplate(s);
const refuses = (s: string, pattern: RegExp) =>
  assert.throws(() => parseTemplate(s), (e: unknown) => {
    assert.ok(e instanceof ReferenceSyntaxError, `expected ReferenceSyntaxError, got ${String(e)}`);
    assert.match(e.message, pattern);
    return true;
  });

describe('what a value can be', () => {
  it('leaves a plain string alone', () => {
    assert.deepEqual(parse('Bearer cus_alice'), [{ kind: 'literal', text: 'Bearer cus_alice' }]);
    assert.ok(isLiteral(parse('nothing here')));
  });

  it('reads an environment variable, with and without a default', () => {
    assert.deepEqual(parse('${API_TOKEN}'), [{ kind: 'env', name: 'API_TOKEN' }]);
    assert.deepEqual(parse('${PORT:-7432}'), [{ kind: 'env', name: 'PORT', fallback: '7432' }]);
    // An empty default is a default, not an absent one.
    assert.deepEqual(parse('${X:-}'), [{ kind: 'env', name: 'X', fallback: '' }]);
  });

  it('reads a secret reference', () => {
    assert.deepEqual(parse('${secret:alice_token}'), [{ kind: 'secret', name: 'alice_token' }]);
  });

  it('mixes literals and references in one string', () => {
    assert.deepEqual(parse('Bearer ${secret:alice_token}'), [
      { kind: 'literal', text: 'Bearer ' },
      { kind: 'secret', name: 'alice_token' },
    ]);
    assert.deepEqual(
      parse('postgresql://${DB_USER}:${secret:db_password}@localhost/x').map((p) => p.kind),
      ['literal', 'env', 'literal', 'secret', 'literal'],
    );
  });

  it('honours the escape', () => {
    assert.deepEqual(parse('$${API_TOKEN}'), [{ kind: 'literal', text: '${API_TOKEN}' }]);
    assert.deepEqual(parse('$${secret:x}'), [{ kind: 'literal', text: '${secret:x}' }]);
  });

  it('lists the secrets a template needs, once each', () => {
    assert.deepEqual(secretsIn(parse('${secret:a} and ${secret:b} and ${secret:a}')), ['a', 'b']);
    assert.deepEqual(secretsIn(parse('${JUST_ENV}')), []);
  });
});

describe('what it refuses', () => {
  it('refuses a placeholder it does not recognise, rather than passing it through', () => {
    // The bug this closes: `${secret:x}` did not match the environment pattern,
    // so it survived untouched and would have been sent as those characters.
    refuses('${not a var}', /not a reference this understands/);
    refuses('${}', /not a reference this understands/);
    refuses('${1_STARTS_WITH_DIGIT}', /not a reference this understands/);
  });

  it('refuses a misspelled secret reference and says the right form', () => {
    for (const bad of ['${SECRET:x}', '${secret: x}', '${Secret:x}', '${secret.x}']) {
      refuses(bad, /form is .\$\{secret:name\}|not a usable secret name/);
    }
  });

  it('refuses a default on a secret', () => {
    // A default would be a credential written into the file — the one thing
    // this syntax exists to avoid.
    refuses('${secret:db_password:-hunter2}', /default would be a credential written into/);
    refuses('${secret:db_password:-hunter2}', /statescope secret set db_password/);
  });

  it('refuses an empty or unusable secret name', () => {
    refuses('${secret:}', /names no secret/);
    refuses('${secret:Has Spaces}', /not a usable secret name/);
    // ...and suggests something that would work.
    refuses('${secret:My Token}', /\$\{secret:my_token\}/);
  });

  it('tells the reader how to write the characters literally', () => {
    refuses('${not a var}', /escape it as/);
  });
});

describe('naming a workspace slot', () => {
  it('turns a workspace name into something a keyring can hold', () => {
    assert.equal(namespaceFor('Demo Bank'), 'demo_bank');
    assert.equal(namespaceFor('shopfront'), 'shopfront');
    assert.equal(namespaceFor('My App (staging)'), 'my_app_staging');
    assert.equal(namespaceFor('  spaced  '), 'spaced');
  });

  it('always produces something usable, whatever the name was', () => {
    // A name in a script this cannot slug must still get a slot rather than
    // failing at the moment someone tries to store a credential.
    for (const name of ['中文项目', '!!!', '', '---']) {
      assert.match(namespaceFor(name), NAMESPACE, `\`${name}\` produced an unusable namespace`);
    }
  });

  it('splits a stored key back into its parts', () => {
    assert.deepEqual(unqualify(qualify('demo_bank', 'alice_token')), {
      namespace: 'demo_bank',
      id: 'alice_token',
    });
  });

  it('does not claim an item that is not ours, or one from before namespaces', () => {
    assert.equal(unqualify('com.apple.something'), null);
    // Written before namespaces existed: guessing which workspace it belonged
    // to would be worse than leaving it alone.
    assert.equal(unqualify('dev.statescope.secret.alice_token'), null);
  });
});

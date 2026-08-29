/**
 * Against the real Keychain, because the whole implementation is a reaction to
 * how `security` actually behaves — it reports a value as text or as bare
 * hexadecimal depending on its bytes, with nothing to say which — and a mock
 * would only restate what I assumed.
 *
 * Every item is created and removed inside the test, under a service prefix
 * nothing else uses. Skipped off macOS.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { MacOSKeychain } from './macos.js';

const onMac = process.platform === 'darwin';
/** A namespace nothing else uses, so these never touch a real workspace's items. */
const NS = `test-ns-${process.pid}`;
const ids: string[] = [];

/** A name nothing else will collide with, remembered so it can be removed. */
function scratch(label: string): string {
  const id = `test-${label}-${process.pid}`;
  ids.push(id);
  return id;
}

after(async () => {
  if (!onMac) return;
  const store = await MacOSKeychain.probe(NS);
  for (const id of ids) await store.delete(id).catch(() => undefined);
});

describe('the macOS Keychain', () => {
  it('round-trips every kind of value a credential can be', async (t) => {
    if (!onMac) return t.skip('not macOS');
    const store = await MacOSKeychain.probe(NS);
    const values: Array<[string, string]> = [
      ['plain', 'cus_alice_9f3a2b'],
      // `security` switches to hex output for these, with no marker, which is
      // the reason the value is base64-encoded before it is stored at all.
      ['newline', 'line1\nline2'],
      ['unicode', 'üñïçödé 中文 🔑'],
      ['quotes', `has 'single' and "double" and \\ backslash`],
      ['shellish', 'a $DOLLAR `tick` and ; semicolon'],
      ['spaces', '  leading and trailing  '],
      ['long', 'x'.repeat(2900)],
      // This one is the ambiguity itself: text that looks exactly like hex.
      ['hexlike', 'deadbeefcafe'],
    ];
    for (const [label, value] of values) {
      const id = scratch(label);
      await store.set(id, value);
      const back = await store.get(id);
      assert.ok(back, `${label}: nothing came back`);
      assert.equal(back.reveal(), value, `${label} did not survive the round trip`);
    }
  });

  it('reports a missing secret as absent rather than failing', async (t) => {
    if (!onMac) return t.skip('not macOS');
    const store = await MacOSKeychain.probe(NS);
    assert.equal(await store.get(`test-never-set-${process.pid}`), undefined);
  });

  it('overwrites rather than duplicating', async (t) => {
    if (!onMac) return t.skip('not macOS');
    const store = await MacOSKeychain.probe(NS);
    const id = scratch('overwrite');
    await store.set(id, 'first');
    await store.set(id, 'second');
    assert.equal((await store.get(id))?.reveal(), 'second');
  });

  it('says whether a delete removed anything', async (t) => {
    if (!onMac) return t.skip('not macOS');
    const store = await MacOSKeychain.probe(NS);
    const id = scratch('delete');
    await store.set(id, 'x');
    assert.equal(await store.delete(id), true);
    assert.equal(await store.delete(id), false, 'a second delete removes nothing');
    assert.equal(await store.get(id), undefined);
  });

  it('lists what it stored and nothing else', async (t) => {
    if (!onMac) return t.skip('not macOS');
    // The listing must not include credentials other applications put in the
    // same keyring — a person must not be shown, or offered a way to delete,
    // a password this tool never stored.
    const store = await MacOSKeychain.probe(NS);
    const id = scratch('listed');
    await store.set(id, 'x');
    const listed = await store.list();
    assert.ok(listed.some((s) => s.id === id), 'the item just stored should be listed');
    assert.ok(
      listed.every((s) => /^[a-z0-9][a-z0-9_-]*$/.test(s.id)),
      'every listed id should be one this tool could have written',
    );
  });

  it('keeps the value out of the process argument list', async (t) => {
    if (!onMac) return t.skip('not macOS');
    // `security add-generic-password -w <value>` puts the credential where
    // `ps` shows it to every user on the machine. The value goes through
    // stdin instead, and this checks the implementation still does that.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./macos.ts', import.meta.url), 'utf8'),
    );
    const setBody = source.slice(source.indexOf('async set('), source.indexOf('async delete('));
    assert.match(setBody, /run\(\s*\['-i'\]/, 'set() should drive `security -i`');
    assert.doesNotMatch(setBody, /'-w',\s*\n?\s*encoded/, 'the value must not be an argv element');
  });

  it('refuses a value too long for the safe path rather than exposing it', async (t) => {
    if (!onMac) return t.skip('not macOS');
    // The unsafe path exists and works: `-w <value>` stores any length. It is
    // refused because the value would sit in the process argument list, and a
    // promise that holds only for short credentials is not a promise.
    const store = await MacOSKeychain.probe(NS);
    await assert.rejects(
      () => store.set(scratch('toolong'), 'x'.repeat(4000)),
      /refuses rather than doing that quietly/,
    );
  });

  it('refuses an item this tool did not write, rather than decoding it', async (t) => {
    if (!onMac) return t.skip('not macOS');
    // Measured: without a marker, a value a person typed into Keychain Access
    // by hand — `Bearer cus_alice` — comes back as eleven bytes of binary and
    // every check reports it configured. The API then rejects a credential
    // nobody can see is wrong.
    const store = await MacOSKeychain.probe(NS);
    const id = scratch('foreign');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('/usr/bin/security', [
      'add-generic-password',
      '-s',
      `dev.tuplescope.secret.${NS}.${id}`,
      '-a',
      'tuplescope',
      '-w',
      'Bearer cus_alice',
      '-U',
    ]);
    await assert.rejects(() => store.get(id), /was not written by TupleScope/);
    // ...and `has` still says it is there, because it is.
    assert.equal(await store.has(id), true);
  });

  it('answers `has` without decrypting', async (t) => {
    if (!onMac) return t.skip('not macOS');
    // The difference matters: decrypting is what raises the permission dialog
    // and what blocks on a locked keychain, and `status` runs when things are
    // already wrong.
    const store = await MacOSKeychain.probe(NS);
    const id = scratch('has');
    assert.equal(await store.has(id), false);
    await store.set(id, 'x');
    assert.equal(await store.has(id), true);
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./macos.ts', import.meta.url), 'utf8'),
    );
    const hasBody = source.slice(source.indexOf('async has('), source.indexOf('async get('));
    assert.doesNotMatch(hasBody, /'-w'/, '`has` must not ask for the password');
  });

  it('keeps two workspaces that want the same name apart', async (t) => {
    if (!onMac) return t.skip('not macOS');
    // The collision this closes was invisible: two checkouts both referring to
    // `api_token` shared one value, and the second `set` printed exactly what
    // a first-time store prints.
    const a = new MacOSKeychain(`${NS}-a`);
    const b = new MacOSKeychain(`${NS}-b`);
    const id = 'api-token';
    try {
      await a.set(id, 'value-for-a');
      await b.set(id, 'value-for-b');
      assert.equal((await a.get(id))?.reveal(), 'value-for-a');
      assert.equal((await b.get(id))?.reveal(), 'value-for-b');

      // ...and neither lists the other's, so nobody can delete it by mistake.
      assert.deepEqual((await a.list()).map((s) => s.id), [id]);
      await b.delete(id);
      assert.equal(await a.has(id), true, "deleting b's must not touch a's");
    } finally {
      await a.delete(id).catch(() => undefined);
      await b.delete(id).catch(() => undefined);
    }
  });

  it('refuses a namespace that could not have come from a workspace', async (t) => {
    if (!onMac) return t.skip('not macOS');
    assert.throws(() => new MacOSKeychain('Has Spaces'), /not a usable secret namespace/);
    assert.throws(() => new MacOSKeychain('has.a.dot'), /not a usable secret namespace/);
  });

  it('refuses a name that could not have come from a reference', async (t) => {
    if (!onMac) return t.skip('not macOS');
    const store = await MacOSKeychain.probe(NS);
    await assert.rejects(() => store.get('../../etc/passwd'), /not a usable secret name/);
    await assert.rejects(() => store.set('Has Spaces', 'x'), /not a usable secret name/);
  });
});

/**
 * The three states, and which of them anything can actually produce.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { displayText, isVisible, masked, requireText, unknown, ValueUnavailable, visible } from './value.js';

describe('the three states', () => {
  it('gives a masked value no text at all, not a placeholder', () => {
    // The placeholder used to travel with the value, and five separate places
    // read it as data — a promoted assertion whose expected literal was the
    // bullets, a SELECT addressing a row by them, an UPDATE reported as an
    // insert because every masked key collapsed to the same string. Absent
    // `text` is `undefined` in JS and a KeyError in Python.
    const value = masked('numeric');
    assert.equal(Object.hasOwn(value, 'text'), false);
    assert.equal(isVisible(value), false);
    // ...and it still says what type it is. One shared placeholder hardcoded
    // `text`, so a masked numeric compared, rendered and promoted as a string.
    assert.equal(value.pgType, 'numeric');
  });

  it('refuses through requireText rather than returning something usable', () => {
    assert.equal(requireText(visible('text', 'x'), 'a'), 'x');
    assert.equal(requireText(visible('text', null), 'a'), null);
    assert.throws(() => requireText(masked('text'), 'the key'), ValueUnavailable);
    assert.throws(() => requireText(undefined, 'the key'), /was not read/);
    assert.throws(() => requireText(unknown('text', 'unreadable'), 'the key'), /unreadable/);
  });

  it('renders each state distinctly, and never as the others', () => {
    // `‹unknown›` and not bullets: a value that could not be read is not a
    // secret, and showing it as one invites the reader to look for a setting
    // that would reveal it.
    assert.equal(displayText(visible('text', 'x')), 'x');
    assert.equal(displayText(visible('text', null)), 'NULL');
    assert.equal(displayText(masked('text')), '••••••••');
    assert.equal(displayText(unknown('text', 'toast-not-carried')), '‹unknown›');
    assert.equal(displayText(undefined), '‹unknown›');
  });
});

describe('the unknown arm', () => {
  it('is not produced anywhere, which is measured and not assumed', async () => {
    // A column big enough to be out-of-line TOASTed cannot be in a btree index
    // — PostgreSQL refuses: `index row requires 12816 bytes, maximum size is
    // 8191` — and row identity here is always a primary key or a unique index.
    // Row images come from the database rather than the decoded log, so the
    // sentinel cannot reach a reported value either.
    //
    // When that changes, this test fails, and whoever added the producer is
    // told to cover the paths it makes reachable: predicates, promotion,
    // locators and the two targets all have an `unknown` branch that nothing
    // exercises today.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const offenders: string[] = [];
    for await (const file of sources(root)) {
      if (file.endsWith('/value.ts') || file.includes('.test.')) continue;
      const text = await readFile(file, 'utf8');
      // The constructor, called — not the type, mentioned.
      if (/\bunknown\s*\(\s*['"`]/.test(text)) offenders.push(file.slice(root.length + 1));
    }
    assert.deepEqual(
      offenders,
      [],
      `\n  Something now produces \`unknown\`. Good — but the branches written for it have never ` +
        `run.\n  Add coverage, then delete this test.\n  ${offenders.join('\n  ')}`,
    );
  });
});

async function* sources(root: string): AsyncGenerator<string> {
  for (const area of ['packages', 'apps']) {
    for (const pkg of await readdir(join(root, area), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      yield* walk(join(root, area, pkg.name, 'src'));
    }
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

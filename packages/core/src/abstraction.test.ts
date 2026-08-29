/**
 * The one test that fails when the abstraction has quietly stopped being one.
 *
 * A ChangeSet is supposed to mean the same thing to a consumer no matter which
 * engine produced it. Nothing enforces that at the type level: `captureMethod`
 * is right there on the object, and the cheapest fix for any engine-specific
 * quirk will always be `if (captureMethod === 'wal')`. The first one reads as
 * pragmatic. After the third, the contract is decorative and the real interface
 * is the union of everything every engine happens to do.
 *
 * So the rule is mechanical: a consumer may ask what an engine *can do*
 * (`detection`, `fidelity`) and may *display* which engine ran. It may never
 * change its answer based on the engine's name.
 *
 * This is a source-text test, which is a blunt instrument, but the thing it
 * guards is a habit rather than a type — and a habit needs something that fails
 * in review, not a convention in a document nobody rereads.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = new URL('../../../', import.meta.url).pathname;

/**
 * Everything downstream of capture. `db-postgres` is excluded because it *is*
 * the producer — engines are entitled to know which engine they are — and so is
 * `core`, which declares the vocabulary.
 */
const CONSUMERS = [
  'packages/expr',
  'packages/scenario-engine',
  'packages/report',
  'packages/workspace',
  'apps/cli',
  'apps/mcp',
  'apps/runtime',
  'apps/web',
];

function sources(dir: string): string[] {
  const abs = join(ROOT, dir);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(p);
    }
  };
  try {
    walk(abs);
  } catch {
    // A package with no source yet is not a violation.
  }
  return out;
}

const ENGINE_NAMES = ['mvcc-xmin', 'snapshot-diff', 'wal'];

describe('consumers do not know which engine ran', () => {
  it('never compares captureMethod against a literal', () => {
    const offences: string[] = [];
    for (const pkg of CONSUMERS) {
      for (const file of sources(pkg)) {
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          // `captureMethod === 'wal'` in any spelling, and the bare-literal
          // form `=== 'wal'` that a destructured variable would produce.
          const compares =
            /captureMethod\s*[!=]==?/.test(line) ||
            ENGINE_NAMES.some((n) => new RegExp(`[!=]==?\\s*['"\`]${n}['"\`]`).test(line));
          if (compares) offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    assert.deepEqual(
      offences,
      [],
      `A consumer is branching on the engine's name. The engine is allowed to differ; ` +
        `what a consumer reads must not. If an engine genuinely cannot be described by ` +
        `detection and fidelity, the contract is missing an axis — add it to ChangeSet ` +
        `rather than teaching consumers the engine list.\n\n${offences.join('\n')}`,
    );
  });

  it('never reaches for a snapshot that only one engine could have', () => {
    // Whatever an engine keeps in order to compute a ChangeSet is its own
    // business. The moment a consumer reads `beforeSnapshot`, snapshot-diff has
    // become the interface and every other engine has to fake it.
    const offences: string[] = [];
    for (const pkg of CONSUMERS) {
      for (const file of sources(pkg)) {
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          if (/\b(beforeSnapshot|afterSnapshot|snapshotOf|beforeRows|afterRows|walRecords|lsn)\b/.test(line)) {
            offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    }
    assert.deepEqual(offences, [], `A consumer is reading an engine's internals:\n${offences.join('\n')}`);
  });

  it('checks a set of packages that actually exists', () => {
    // Renaming a package must not silently empty this test out.
    for (const pkg of CONSUMERS) {
      assert.ok(sources(pkg).length > 0, `${pkg} has no sources — has it moved?`);
    }
  });
});

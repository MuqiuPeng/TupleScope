/**
 * That a resolved credential cannot reach either stream once it is known.
 *
 * Measured before: with `${secret:probe}` as the database name, `status` and
 * `check` printed `database "scrubme-zz7q" does not exist` — the value, from
 * the driver's own text, on a path that never asked the scrubber. The fix puts
 * the substitution on the streams; these tests hold the streams to it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact, Secret } from '@tuplescope/secrets';
import { installScrubber, scrubbed } from './scrub.js';

function fakeStream(): { write: (chunk: unknown) => boolean; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    write(chunk: unknown) {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    },
  };
}

const probe = new Secret('scrubme-zz7q', 'probe');
const scrub = (text: string): string => redact(text, [probe]);

describe('installScrubber', () => {
  it('takes a resolved value out of text somebody else formatted', () => {
    const out = fakeStream();
    installScrubber(scrub, [out]);
    out.write('Could not reach the database: database "scrubme-zz7q" does not exist\n');
    out.write('getaddrinfo ENOTFOUND scrubme-zz7q\n');
    assert.ok(out.seen.every((line) => !line.includes('scrubme-zz7q')), out.seen.join(''));
    assert.match(out.seen[0]!, /\[secret probe\]/);
  });

  it('covers bytes as well as strings', () => {
    const out = fakeStream();
    installScrubber(scrub, [out]);
    out.write(Buffer.from('a stack trace mentioning scrubme-zz7q'));
    assert.doesNotMatch(out.seen[0]!, /scrubme-zz7q/);
  });

  it('wraps a stream once, and a second install replaces the substitution', () => {
    const out = fakeStream();
    installScrubber(scrub, [out]);
    const other = new Secret('another-value-9', 'other');
    installScrubber((text) => redact(text, [other]), [out]);
    out.write('another-value-9');
    assert.equal(out.seen[0], '[secret other]');
    assert.equal(scrubbed('another-value-9'), '[secret other]');
  });

  it('leaves a value shorter than six characters alone — redact’s floor, said out loud', () => {
    // Substituting a two-character password out of every message corrupts more
    // than it protects; the README and scrub.ts both say so. Pinned here so a
    // change to the floor is a change somebody sees.
    const out = fakeStream();
    installScrubber((text) => redact(text, [new Secret('abcde', 'short')]), [out]);
    out.write('abcde');
    assert.equal(out.seen[0], 'abcde');
  });
});

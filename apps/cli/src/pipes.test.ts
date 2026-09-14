/**
 * A reader that leaves early is not an error; every other write error still is.
 *
 * Measured before: `tuplescope status | true` and `run … | head -4` died with
 * an unhandled 'error' event, `Error: write EPIPE` and a 25-line stack. The
 * process-level case is in `main.test.ts`; these hold the guard to its rule.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { ignoreClosedPipes } from './pipes.js';

function fakeStream() {
  const seen: string[] = [];
  const stream = Object.assign(new EventEmitter(), {
    write(chunk: string, callback?: () => void): boolean {
      seen.push(chunk);
      callback?.();
      return true;
    },
  });
  return { stream, seen };
}

const failure = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`write ${code}`), { code });

describe('ignoreClosedPipes', () => {
  it('passes writes through while someone is reading', () => {
    const { stream, seen } = fakeStream();
    ignoreClosedPipes([stream]);
    stream.write('one\n');
    assert.deepEqual(seen, ['one\n']);
  });

  it('drops what comes after EPIPE, quietly, and still answers callbacks', async () => {
    const { stream, seen } = fakeStream();
    ignoreClosedPipes([stream]);
    assert.doesNotThrow(() => stream.emit('error', failure('EPIPE')));
    // A second EPIPE — every write to a closed pipe reports one — is as quiet.
    assert.doesNotThrow(() => stream.emit('error', failure('EPIPE')));
    let answered = false;
    assert.equal(stream.write('after\n', () => (answered = true)), true);
    await new Promise((resolve) => process.nextTick(resolve));
    assert.equal(answered, true, 'a caller waiting on its callback must hear back');
    assert.deepEqual(seen, [], 'nothing is written to a pipe nobody reads');
  });

  it('does not mask any other write error', () => {
    const { stream } = fakeStream();
    ignoreClosedPipes([stream]);
    assert.throws(() => stream.emit('error', failure('EIO')), /write EIO/);
    assert.throws(() => stream.emit('error', failure('ENOSPC')), /write ENOSPC/);
  });
});

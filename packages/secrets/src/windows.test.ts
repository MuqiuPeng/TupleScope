/**
 * The Windows backend's wire format, on any platform.
 *
 * There is no Windows runner in CI and no Credential Manager here, so the store
 * itself cannot be exercised. The channel it reads through is a pure function,
 * and this is what can honestly be tested from a Mac.
 *
 * **No live bug is being fixed here.** The parser used to `.trim()` the whole
 * line before splitting, which would corrupt a value ending in whitespace — but
 * the payload crossing this channel is base64, which has no significant
 * whitespace, so the corruption was unreachable. What these tests pin is that
 * the channel is correct *on its own terms* rather than by accident of what its
 * one caller happens to put through it: the day someone stops base64-ing the
 * payload, the format should not quietly start eating bytes.
 *
 * The same goes for the non-numeric code. `Number('oops')` is NaN, and
 * `NaN !== 0` is true, so a garbled line already reached the failure path — by
 * a coincidence of IEEE comparison rather than by a decision. It is a decision
 * now.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { split } from './windows.js';

describe('the code/payload channel', () => {
  it('reads a plain success', () => {
    assert.deepEqual(split('0\tok\n'), { code: 0, payload: 'ok' });
  });

  it('keeps whitespace the value actually ends with', () => {
    // Not reachable through the current caller — the payload is base64 — but
    // the format should not depend on that to be correct.
    assert.equal(split('0\thunter2  \n').payload, 'hunter2  ');
    assert.equal(split('0\thunter2\t\n').payload, 'hunter2\t');
  });

  it('keeps whitespace the value begins with', () => {
    assert.equal(split('0\t  hunter2\n').payload, '  hunter2');
  });

  it('keeps a tab inside the value, splitting only on the first', () => {
    // The separator is a tab and a secret may contain one; only the first can
    // be the delimiter or the format is ambiguous.
    assert.equal(split('0\ta\tb\tc\n').payload, 'a\tb\tc');
  });

  it('strips exactly one trailing newline, not every blank line', () => {
    // `Write-Output` adds one. A value that genuinely ends in a blank line must
    // keep the rest of it.
    assert.equal(split('0\tline\n\n').payload, 'line\n');
    assert.equal(split('0\tline\r\n').payload, 'line');
  });

  it('carries an error code back rather than a value', () => {
    assert.deepEqual(split('1168\t\n'), { code: 1168, payload: '' });
  });

  it('refuses output with no separator instead of guessing', () => {
    // Anything without a tab is not this protocol — an unhandled PowerShell
    // error, a policy banner, an empty stream. Reporting -1 sends the caller to
    // the failure path rather than handing it half a line as a secret.
    assert.deepEqual(split('some unexpected banner\n'), { code: -1, payload: '' });
    assert.deepEqual(split(''), { code: -1, payload: '' });
  });

  it('refuses a non-numeric code rather than reading it as NaN', () => {
    // `Number('oops')` is NaN, which is neither 0 nor a known error number, and
    // every comparison against it is false — so a garbled line used to fall
    // through as "not an error" carrying whatever followed the tab.
    assert.deepEqual(split('oops\tvalue\n'), { code: -1, payload: '' });
  });

  it('tolerates leading whitespace before the code', () => {
    assert.deepEqual(split('  0\tok\n'), { code: 0, payload: 'ok' });
  });
});

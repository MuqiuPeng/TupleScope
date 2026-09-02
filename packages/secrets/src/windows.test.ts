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
import { SHIM, split } from './windows.js';

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

/**
 * The shim, checked at the boundary it has to cross.
 *
 * This is the one thing about the Windows backend that can be settled from any
 * machine, and it decided everything: the C# was joined with `` `n ``, which is
 * PowerShell's newline escape written where C#'s `\n` belonged. Inside an
 * expandable here-string PowerShell turned it into a real newline before
 * compilation, csc met a line break inside a string literal, and `Add-Type`
 * failed as a unit — so `probe()` reported the store unavailable and the whole
 * backend had never worked, on any Windows machine, ever.
 *
 * A test that ran the shim would need Windows. A test that checks nothing in it
 * *survives the trip* needs only the rules of the two languages, which is why
 * this one exists and why it is worth more than it looks.
 */
describe('the PowerShell shim', () => {
  const body = SHIM.slice(SHIM.indexOf("@'") + 2, SHIM.lastIndexOf("'@"));

  it('hands the C# to Add-Type in a here-string PowerShell will not rewrite', () => {
    // `@'…'@` substitutes nothing. `@"…"@` substitutes `$name` and processes
    // backtick escapes — in a document that is C#, where both mean something
    // else. Using the quoting form that cannot rewrite is what makes the class
    // of mistake impossible rather than fixing one instance of it.
    assert.match(SHIM, /Add-Type -Language CSharp @'/);
    assert.doesNotMatch(SHIM, /Add-Type -Language CSharp @"/);
  });

  it('contains nothing an expandable here-string would have eaten', () => {
    // Belt and braces: even under `@"…"@` this body would now survive intact.
    // If someone changes the quoting back, this fails rather than the backend
    // silently ceasing to compile on a platform nobody here can run.
    assert.equal(body.includes('`'), false, 'a backtick in the C# is a PowerShell escape');
    assert.doesNotMatch(body, /\$[A-Za-z_(]/, 'a $name in the C# is a PowerShell variable');
  });

  it('joins with the escape C# understands, not the one PowerShell does', () => {
    // The actual defect, pinned by its bytes. `\n` is backslash-n; `` `n `` is
    // U+0060 followed by n, and C# has no such escape.
    assert.match(body, /String\.Join\("\\n"/);
    assert.equal(body.includes('String.Join("\u0060n"'), false);
  });

  it('opens and closes the here-string exactly once', () => {
    // A stray delimiter would truncate the C# and produce a compile error that
    // reads nothing like its cause.
    assert.equal(SHIM.split("@'").length - 1, 1);
    assert.equal(SHIM.split("'@").length - 1, 1);
  });
});

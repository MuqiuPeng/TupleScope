/**
 * The commands are mostly about what they refuse to print.
 *
 * A credential is in a keychain rather than a file so that displaying it is a
 * deliberate act. A surface where the everyday command puts a bearer token into
 * terminal scrollback — and therefore into a screen recording, a pasted
 * traceback, a shell history file — has moved the secret somewhere no less
 * public than the file it came out of.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { readValue, type Prompt } from './secrets.js';

const SOURCE = readFileSync(new URL('./secrets.ts', import.meta.url), 'utf8');

/**
 * The same file with comments removed.
 *
 * Prose explaining why a `--value` flag does not exist is not a `--value`
 * flag, and a guard that cannot tell the two apart fails on its own
 * explanation.
 */
const CODE = SOURCE.split('\n')
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  })
  .join('\n');

describe('the secret command surface', () => {
  it('reveals a value in exactly one place, behind a flag', () => {
    // `reveal()` is named to be conspicuous precisely so this test can count
    // its uses and a new one has to be argued for.
    const reveals = [...SOURCE.matchAll(/\.reveal\(\)/g)];
    assert.equal(reveals.length, 1, 'a second place that reveals a value needs a reason');
    const around = SOURCE.slice(Math.max(0, reveals[0]!.index - 400), reveals[0]!.index);
    assert.match(around, /if \(show\)/, 'the one place must be behind --show');
  });

  it('warns, on stderr, that --show puts the value in the shell history', () => {
    assert.match(SOURCE, /shell history/);
    // On stderr, so `--show` can still be piped without the warning joining it.
    const showBlock = SOURCE.slice(SOURCE.indexOf('if (show)'), SOURCE.indexOf('return 0;\n  }\n  process.stdout.write(`${name}  configured'));
    assert.match(showBlock, /process\.stderr\.write\([^)]*shell history/);
  });

  it('never accepts a value as a command-line argument', () => {
    // A `--value` flag writes the credential into the shell's history file and
    // shows it in `ps` — the two places it is hardest to remove from.
    assert.doesNotMatch(CODE, /values\.value|'--value'|args\[2\]/);
    assert.match(CODE, /readValue/);
  });

  it('reads from the terminal with the echo off, and from a pipe otherwise', () => {
    assert.match(SOURCE, /setRawMode\(true\)/);
    assert.match(SOURCE, /input: process\.stdin/);
    assert.match(SOURCE, /if \(!input\.isTTY\)/);
    // Ctrl-C must leave the terminal usable rather than echo-less.
    assert.match(SOURCE, /byte === 3 \|\| byte === 4/);
    assert.match(SOURCE, /setRawMode\(wasRaw\)/);
  });

  it('says which store it used, so nobody has to guess where it went', () => {
    assert.match(SOURCE, /stored in the \$\{store\.description\}/);
  });

  it('states the boundary in its own help text', () => {
    // Someone reading `secret --help` should learn the rule that governs the
    // feature, not just the four verbs.
    assert.match(SOURCE, /reads only this store/);
    assert.match(SOURCE, /\\\$\{VAR\}\\` reads only the environment/);
    assert.match(SOURCE, /[Nn]either ever falls back to the other/);
  });
});

describe('the workspace never has to hold a credential', () => {
  it('shows the reference form in the help, not a value', () => {
    assert.match(SOURCE, /secret:alice_token/);
    // ...and no example that looks like a real token someone might copy.
    assert.doesNotMatch(SOURCE, /Bearer [a-z]{2,}_[A-Za-z0-9]{8,}/);
  });
});

// ─── the prompt, driven without a terminal ────────────────────────────────────

/**
 * A terminal that records, in one list, when the echo went off and when the
 * prompt was written. The order is the whole defect: measured with expect
 * sending the moment the prompt appeared, the value landed in the pty
 * transcript in 6 of 12 runs, because the prompt was written first and
 * `setRawMode(true)` came after it.
 */
function fakeTerminal(wasRaw = false) {
  const log: string[] = [];
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: wasRaw,
    setRawMode(mode: boolean) {
      log.push(`raw ${mode}`);
      input.isRaw = mode;
      return input;
    },
    resume() {
      log.push('resume');
      return input;
    },
    pause() {
      log.push('pause');
      return input;
    },
  });
  const output = {
    write(text: string): boolean {
      log.push(text.startsWith('Value for') ? 'prompt' : `write ${JSON.stringify(text)}`);
      return true;
    },
  };
  return { log, input, output, prompt: { input, output } as unknown as Prompt };
}

const bytes = (...codes: number[]) => Buffer.from(codes);
const text = (value: string) => Buffer.from(value, 'utf8');

describe('secret set at a terminal', () => {
  it('turns the echo off before the prompt is on screen', async () => {
    const t = fakeTerminal();
    const pending = readValue('tty_secret', t.prompt);
    assert.deepEqual(t.log, ['raw true', 'prompt', 'resume']);
    t.input.emit('data', text('typed-on-tty-9f3'));
    t.input.emit('data', bytes(13));
    assert.equal(await pending, 'typed-on-tty-9f3');
    assert.deepEqual(t.log.slice(3), ['raw false', 'pause', `write ${JSON.stringify('\n')}`]);
  });

  it('stores nothing and restores the terminal on Ctrl-C, Ctrl-D and a closed stdin', async () => {
    for (const end of [
      (t: ReturnType<typeof fakeTerminal>) => t.input.emit('data', bytes(104, 97, 108, 102, 3)),
      (t: ReturnType<typeof fakeTerminal>) => t.input.emit('data', bytes(104, 4)),
      (t: ReturnType<typeof fakeTerminal>) => t.input.emit('end'),
    ]) {
      const t = fakeTerminal();
      const pending = readValue('x', t.prompt);
      end(t);
      assert.equal(await pending, undefined);
      assert.equal(t.input.isRaw, false, t.log.join(', '));
      assert.equal(t.input.listenerCount('data'), 0);
    }
  });

  it('restores the terminal when stdin fails or the prompt cannot be written', async () => {
    const failing = fakeTerminal();
    const pending = readValue('x', failing.prompt);
    failing.input.emit('error', new Error('read EIO'));
    await assert.rejects(pending, /read EIO/);
    assert.equal(failing.input.isRaw, false);

    const mute = fakeTerminal();
    mute.output.write = () => {
      throw new Error('write EIO');
    };
    await assert.rejects(readValue('x', mute.prompt), /write EIO/);
    assert.equal(mute.input.isRaw, false);
    assert.equal(mute.input.listenerCount('data'), 0);
  });

  it('leaves a terminal that was already raw as raw', async () => {
    const t = fakeTerminal(true);
    const pending = readValue('x', t.prompt);
    t.input.emit('data', text('v'));
    t.input.emit('data', bytes(10));
    assert.equal(await pending, 'v');
    assert.equal(t.input.isRaw, true);
  });
});

/**
 * Every write this process makes, with resolved credentials taken back out.
 *
 * The scrubber used to be a function each print site had to remember to call,
 * and one did. Measured: with `${secret:probe}` as the database name, `status`
 * and `check` both printed `database "scrubme-zz7q" does not exist` — the
 * driver's text, the secret's value, verbatim. As the host it was `getaddrinfo
 * ENOTFOUND scrubme-zz7q`. The value was known and resolved; the lines that
 * printed the driver's message simply never passed it through.
 *
 * So it is applied where every line has to go anyway: the two streams. A print
 * site added next year cannot forget it, and neither can the last-resort stack
 * trace in `main`'s catch.
 *
 * `--ascii` is the second stage on the same wrapper (`ascii.ts`), for the same
 * reason: a flag each print site had to honour was honoured by some of them.
 * It runs after the scrub, so the substitution always sees a value exactly as
 * it was resolved: spelled in ASCII first, a credential containing `·` would
 * no longer match, and would go out readable.
 *
 * `redact` skips values shorter than six characters — a two-character
 * password cannot be substituted out of every message without corrupting it,
 * and is not being kept secret by this tool anyway. A secret that short is
 * printed as it is, here as everywhere.
 */

import { asciiGlyphs, escapeDocument } from './ascii.js';

type Scrub = (text: string) => string;

interface Stream {
  write: (...args: never[]) => boolean;
}

let active: Scrub = (text) => text;
let ascii = false;
/** Set only for the duration of one `writeVerbatim` call. */
let verbatim = false;
const wrapped = new WeakSet<object>();

/** The same substitution the streams apply, for text on its way somewhere else. */
export function scrubbed(text: string): string {
  return active(text);
}

/**
 * From here on, nothing written to these streams carries a resolved value.
 *
 * Installing again replaces the substitution rather than stacking a second
 * wrapper, so the streams are only ever wrapped once.
 */
export function installScrubber(
  scrub: Scrub,
  streams: ReadonlyArray<Stream> = [process.stdout, process.stderr],
): void {
  active = scrub;
  wrap(streams);
}

/** From here on, the tool's glyphs reach these streams in ASCII (`--ascii`). */
export function installAsciiOutput(
  streams: ReadonlyArray<Stream> = [process.stdout, process.stderr],
): void {
  ascii = true;
  wrap(streams);
}

/**
 * Text that must reach the reader exactly as it is: the one value `secret get
 * --show` prints. Under `--ascii` a credential containing `—` would otherwise
 * be printed as `--`, and a person would copy a password that is not theirs.
 * The scrub still applies; only the glyph stage is skipped.
 */
export function writeVerbatim(stream: Stream, text: string): void {
  verbatim = true;
  try {
    (stream.write as (chunk: string) => boolean)(text);
  } finally {
    verbatim = false;
  }
}

/**
 * A JSON or XML document on its way to a stream, in ASCII when `--ascii` asked
 * for it and unchanged otherwise.
 *
 * Scrubbed here, before escaping, because the escaped form of a non-ASCII
 * credential (`päss`) is not the string the stream's scrub looks for, and
 * would go out unrecognised.
 */
export function asciiDocument(text: string, format: 'json' | 'xml'): string {
  return ascii ? escapeDocument(active(text), format) : text;
}

function wrap(streams: ReadonlyArray<Stream>): void {
  for (const stream of streams) {
    if (wrapped.has(stream)) continue;
    wrapped.add(stream);
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (stream as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]): boolean =>
      write(clean(chunk), ...rest);
  }
}

function finish(text: string): string {
  const safe = active(text);
  return ascii && !verbatim ? asciiGlyphs(safe) : safe;
}

function clean(chunk: unknown): unknown {
  if (typeof chunk === 'string') return finish(chunk);
  if (chunk instanceof Uint8Array) {
    return Buffer.from(finish(Buffer.from(chunk).toString('utf8')), 'utf8');
  }
  return chunk;
}

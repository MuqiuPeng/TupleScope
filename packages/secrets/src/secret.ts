/**
 * A resolved credential, wrapped so that printing it by accident is hard.
 *
 * This tool writes a lot to disk and to terminals: a diff of database rows, a
 * JSON report envelope, a JUnit file a CI system often publishes, run history,
 * a local web UI, and MCP results that reach a language model and its
 * provider's logs. Every one of those is a path a bearer token could take out
 * of the machine, and all of them go through `String()`, `util.inspect` or
 * `JSON.stringify` at some point.
 *
 * So the value lives behind a method whose name has to be typed on purpose, and
 * the three ways a value normally escapes all yield a placeholder instead:
 *
 *   `${token}`            → [secret alice_token]
 *   console.log(token)    → [secret alice_token]
 *   JSON.stringify(token) → "[secret alice_token]"
 *
 * What this does **not** do is protect the value once `.reveal()` is called, or
 * scrub it from the heap. V8 copies and interns strings; a credential that has
 * been a JavaScript string cannot be reliably erased, and a wrapper claiming
 * otherwise would be theatre. The claim here is narrower and real: a secret
 * does not leak by being *incidentally* formatted.
 */
export class Secret {
  readonly #value: string;

  constructor(
    value: string,
    /** For the placeholder, so a redacted log still says which one it was. */
    readonly name: string,
  ) {
    this.#value = value;
  }

  /**
   * The value itself. Named to be conspicuous at the call site and in review:
   * every use is a place a credential enters somewhere less careful.
   */
  reveal(): string {
    return this.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return this.placeholder;
  }

  toJSON(): string {
    return this.placeholder;
  }

  /** `util.inspect`, which is what `console.log` uses on an object. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.placeholder;
  }

  get placeholder(): string {
    return `[secret ${this.name}]`;
  }
}

/**
 * Replaces every occurrence of a resolved secret in arbitrary text.
 *
 * The backstop for the places a `Secret` cannot reach: a driver's error message
 * with the connection string inline, a stack trace, a response body echoed
 * back. Substring replacement is crude and it is the only thing that works on
 * text somebody else formatted.
 *
 * Short values are skipped. Redacting a two-character password out of every
 * message would corrupt more than it protects, and a password that short is not
 * being kept secret by this tool anyway.
 */
export function redact(text: string, secrets: Iterable<Secret>): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret.reveal();
    if (value.length < 6) continue;
    out = out.split(value).join(secret.placeholder);
  }
  return out;
}

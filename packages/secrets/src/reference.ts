/**
 * The one grammar for everything a workspace file can hold in place of a value.
 *
 * A configuration file that is committed to a repository must be able to say
 * *which* credential to use without saying what it is. So a value is one of
 * three things, and the parser's whole job is to keep them apart:
 *
 *   literal              `Bearer cus_alice`
 *   environment variable `${API_TOKEN}`, `${API_TOKEN:-fallback}`
 *   secret reference     `${secret:alice_token}`
 *
 * The boundary between the last two is deliberate and hard. `${VAR}` reads the
 * environment and nothing else; `${secret:x}` reads the secret store and
 * nothing else. In particular **`${secret:x}` never falls back to environment
 * variable `x`** — if it did, the origin of a credential would depend on what
 * happened to be exported, and no one could later say where a value came from.
 *
 * The other rule that matters here: a placeholder this grammar does not
 * recognise is an **error**, not a literal. Before, `${secret:alice_token}` did
 * not match the environment pattern at all, so it passed through untouched and
 * would have been sent to the API as those nineteen characters. A typo must
 * fail loudly rather than travel.
 */

export type Part =
  | { kind: 'literal'; text: string }
  | { kind: 'env'; name: string; fallback?: string }
  /** `name` is *logical*: a profile may later bind it to a different stored id. */
  | { kind: 'secret'; name: string };

export class ReferenceSyntaxError extends Error {
  constructor(
    message: string,
    readonly placeholder: string,
  ) {
    super(message);
    this.name = 'ReferenceSyntaxError';
  }
}

/** Anything `${...}`-shaped, including the `$${` escape. Contents parsed separately. */
const PLACEHOLDER = /\$(\$)?\{([^}]*)\}/g;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Lower-case, digits, underscore, hyphen. A namespace people have to type. */
const SECRET_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Splits one string into its parts, in order. A string with no placeholder
 * comes back as a single literal.
 */
export function parseTemplate(source: string): Part[] {
  const parts: Part[] = [];
  let last = 0;

  for (const match of source.matchAll(PLACEHOLDER)) {
    const [whole, escaped, inside] = match;
    const start = match.index;
    if (start > last) parts.push({ kind: 'literal', text: source.slice(last, start) });
    last = start + whole.length;

    if (escaped) {
      // `$${VAR}` is how a file says it wants the six characters, not a value.
      parts.push({ kind: 'literal', text: whole.slice(1) });
      continue;
    }
    parts.push(parseInside(inside!, whole));
  }

  if (last < source.length) parts.push({ kind: 'literal', text: source.slice(last) });
  if (parts.length === 0) parts.push({ kind: 'literal', text: '' });
  return parts;
}

function parseInside(inside: string, whole: string): Part {
  const secret = /^secret:(.*)$/s.exec(inside);
  if (secret) {
    const name = secret[1]!;
    if (name.includes(':-')) {
      // A default for a secret is a credential written into the file, which is
      // the one thing this syntax exists to prevent.
      throw new ReferenceSyntaxError(
        `\`${whole}\` gives a secret a default value. A default would be a credential ` +
          `written into the workspace file, which is what \`\${secret:…}\` exists to avoid. ` +
          `Set the secret instead: \`statescope secret set ${name.split(':-')[0]}\`.`,
        whole,
      );
    }
    if (!SECRET_NAME.test(name)) {
      throw new ReferenceSyntaxError(
        name.trim() === ''
          ? `\`${whole}\` names no secret.`
          : `\`${whole}\` is not a usable secret name. Use lower-case letters, digits, ` +
            `underscores and hyphens, starting with a letter or digit — for example ` +
            `\`\${secret:${name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'api_token'}}\`.`,
        whole,
      );
    }
    return { kind: 'secret', name };
  }

  const env = /^([^:]*)(?::-(.*))?$/s.exec(inside);
  const name = env?.[1] ?? '';
  if (ENV_NAME.test(name)) {
    const fallback = env?.[2];
    return fallback === undefined ? { kind: 'env', name } : { kind: 'env', name, fallback };
  }

  // Everything else. The likeliest cause by far is a secret reference spelled
  // wrong, so say that rather than describing the environment grammar.
  const looksLikeSecret = /^\s*secret\s*[:.]|^\s*SECRET\s*:/i.test(inside);
  throw new ReferenceSyntaxError(
    looksLikeSecret
      ? `\`${whole}\` is not a secret reference. The form is \`\${secret:name}\` — lower-case ` +
        `\`secret\`, a colon, no spaces.`
      : `\`${whole}\` is not a reference this understands. Use \`\${VAR}\` for an environment ` +
        `variable, \`\${VAR:-default}\` to give it a default, or \`\${secret:name}\` for a stored ` +
        `credential. To write the characters themselves, escape it as \`$${whole}\`.`,
    whole,
  );
}

/** Every secret a template mentions, in order, without duplicates. */
export function secretsIn(parts: ReadonlyArray<Part>): string[] {
  return [...new Set(parts.filter((p) => p.kind === 'secret').map((p) => p.name))];
}

/** True when the string contains nothing that needs resolving. */
export function isLiteral(parts: ReadonlyArray<Part>): boolean {
  return parts.every((p) => p.kind === 'literal');
}

/**
 * A stand-in for a secret reference that survives being written into a string
 * and read back.
 *
 * The config pipeline expands environment references first and resolves secrets
 * later, which means whatever the first pass emits is re-read by the second.
 * Emitting `${secret:x}` verbatim there broke two things at once, both verified:
 *
 *   `$${secret:x}` — the escape that says "these characters, not a value" —
 *   produced the literal text, which the second pass then read as a reference
 *   and resolved. The file asked for characters and got a credential.
 *
 *   `${VAR}` whose value happened to be `${secret:stolen}` produced a reference
 *   the file never contained. That is the environment reaching into the secret
 *   namespace — the exact crossing the grammar exists to forbid — through the
 *   back door.
 *
 * So the first pass emits a marker carrying a nonce minted for that pass, and
 * the second pass substitutes only markers bearing the nonce it was given.
 * Environment content cannot contain it: the nonce did not exist when the
 * environment was written, and guessing it means guessing 128 bits.
 *
 * `\u0000` delimits it because a YAML scalar cannot contain one.
 */
export function secretMarker(nonce: string, name: string): string {
  return `\u0000statescope:${nonce}:${name}\u0000`;
}

export function markerPattern(nonce: string): RegExp {
  return new RegExp(`\u0000statescope:${nonce}:([a-z0-9][a-z0-9_-]*)\u0000`, 'g');
}

/** Every secret named by markers of this nonce, in order, without duplicates. */
export function markedSecrets(text: string, nonce: string): string[] {
  return [...new Set([...text.matchAll(markerPattern(nonce))].map((m) => m[1]!))];
}

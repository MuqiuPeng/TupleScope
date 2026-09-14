/**
 * `${…}` in the parts of a request a scenario file sends.
 *
 * A scenario file resolves no `${…}` of any kind. Credentials live in the
 * workspace file's `identities`, and values from earlier responses travel as
 * `capture:` and `{{name}}`. So every `${…}` in a request is text the author
 * expected something to replace, and nothing will. Only the exact
 * `${secret:name}` spelling used to be refused. `${VAR}` in a header,
 * `${VAR:-default}` in a body, `${secret: x}` and `${SECRET:x}` all reached the
 * API as those characters, and each step still passed (measured with a fake
 * runner: ts-fix/engine-ws/verbatim.mjs).
 *
 * The grammar is the workspace file's (packages/secrets/src/reference.ts),
 * copied rather than imported, because this package does not depend on that
 * one. Anything `${…}`-shaped is a reference, and `$${` is the escape: `$${x}`
 * is sent as `${x}`. The escape is applied to the author's text only, before
 * `{{name}}` is templated. A captured value is data from the API, so a `${`
 * inside one is neither refused nor unescaped.
 */

import type { HttpRequest } from '@tuplescope/core';

/** `PLACEHOLDER` in packages/secrets/src/reference.ts: a reference, or its `$${` escape. */
const REFERENCE = /\$(\$)?\{([^}]*)\}/g;

/** The one spelling with a sentence of its own: a well-formed secret reference. */
export const SECRET_REFERENCE = /^\$\{secret:([a-z0-9][a-z0-9_-]*)\}$/;

/** What to write instead of a reference. The run and `check` both use it, so they say the same thing. */
export const INSTEAD_OF_A_REFERENCE =
  'use `identities` in the workspace file with `as:` for a credential, `capture:` and `{{name}}` ' +
  'for a value from an earlier response, or `$${` to send the characters `${` themselves';

export interface RequestReference {
  /** Where it sits: `request.headers.authorization`, `request.body.items.0`. */
  readonly field: string;
  /** The reference as written, `${VAR}`. */
  readonly reference: string;
  /** In an object key rather than a value. The field is then the object holding it. */
  readonly inKey: boolean;
}

/** `` `request.path` holds `${TENANT}` ``, as both the run and `check` word it. */
export function describeReference({ field, reference, inKey }: RequestReference): string {
  return `\`${field}\` holds \`${reference}\`${inKey ? ' in a key' : ''}`;
}

/**
 * Every unescaped `${…}` in the parts of a request the run sends: the path,
 * the idempotency key, the headers and the body at any depth, in keys as well
 * as values. The old check stringified the whole request, so a key was covered
 * then too.
 */
export function referencesIn(
  request: Pick<HttpRequest, 'path' | 'idempotencyKey' | 'headers' | 'body'>,
): RequestReference[] {
  const found: RequestReference[] = [];
  const seen = new Set<string>();
  const scan = (field: string, text: string, inKey: boolean): void => {
    for (const [reference, escaped] of text.matchAll(REFERENCE)) {
      if (escaped) continue;
      const id = `${field}\u0000${reference}\u0000${inKey}`;
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ field, reference, inKey });
    }
  };
  const visit = (field: string, value: unknown): void => {
    if (typeof value === 'string') {
      scan(field, value, false);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(`${field}.${index}`, item));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        scan(field, key, true);
        visit(`${field}.${key}`, item);
      }
    }
  };
  visit('request.path', request.path);
  visit('request.idempotencyKey', request.idempotencyKey);
  visit('request.headers', request.headers);
  visit('request.body', request.body);
  return found;
}

/** `$${x}` → `${x}`. An unescaped reference is left alone; the run refuses it before sending. */
export function unescapeReferences(text: string): string {
  return text.replace(REFERENCE, (whole: string, escaped: string | undefined) =>
    escaped ? whole.slice(1) : whole,
  );
}

/** `unescapeReferences` over every string in a value, keys included. */
export function unescapeDeep(value: unknown): unknown {
  if (typeof value === 'string') return unescapeReferences(value);
  if (Array.isArray(value)) return value.map(unescapeDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        unescapeReferences(key),
        unescapeDeep(item),
      ]),
    );
  }
  return value;
}

/**
 * The `adminer-url` target: a URL, opened by the platform opener.
 *
 * No process of ours runs against the database and no credential of ours is
 * handed over. Adminer connects with its own, as the user, and is not bound by
 * `maskColumns` — which is the thing to say out loud rather than bury, because
 * it is the whole shape of the trade.
 *
 * Every measurement below is against Adminer 5, with TupleScope on the host and
 * both Adminer and PostgreSQL in containers.
 */

import type { KnownLocation } from '@tuplescope/core';
import { isVisible, type Value } from '@tuplescope/core';
import type { AdminerBinding } from './config.js';

/**
 * Adminer's operator vocabulary, measured from the select form's own markup:
 *
 *   = < > <= >= != ~ ~* !~ LIKE 'LIKE %%' ILIKE 'ILIKE %%' IN
 *   'IS NULL' 'NOT LIKE' 'NOT ILIKE' 'NOT IN' 'IS NOT NULL' SQL
 *
 * There is no `IS NOT DISTINCT FROM`, and none is needed: that operator differs
 * from `=` only when a side is NULL, and `IS NULL` is exact for that case.
 *
 * `SQL` is in the list and is never emitted. Its value is spliced into the
 * WHERE clause, so a builder that can reach it is an injection primitive in a
 * URL. The type below has two members and neither is it.
 */
type AdminerOp = '=' | 'IS NULL';

/**
 * A cap on the rendered URL.
 *
 * Measured: a 4000-character key produced a 4166-character URL that Adminer
 * served correctly, so the ceiling is not Adminer's. It belongs to the browser
 * and to whatever proxy sits between, neither of which is knowable from here —
 * and a URL truncated in transit addresses a different row without saying so.
 * Refusing above a conservative bound is the only honest option.
 */
export const MAX_URL_LENGTH = 2000;

export interface AdminerTargetError {
  readonly reason: 'target-cannot-address';
  readonly target: 'adminer-url';
  readonly detail: string;
}

/**
 * The row-level deep link.
 *
 * Built with `URLSearchParams`, so every component is encoded individually and
 * nothing is concatenated. Measured through this exact shape: values containing
 * `'`, `&` and a newline all round-tripped and selected the right row, as did
 * `bytea` (`\x0102`), `timestamptz` (`2024-03-01 12:00:00+00`), `uuid`,
 * `numeric` and `boolean` — so the capability predicate is not a type
 * allow-list. What it *is* is a requirement that the text be the wire text
 * produced under the pinned rendering settings: the `timestamptz` matched
 * because its rendering carried an explicit `+00`.
 */
export function adminerUrl(
  binding: AdminerBinding,
  location: KnownLocation,
  table: string,
  key: ReadonlyArray<{ name: string; value: Value }>,
): { url: string } | AdminerTargetError {
  if (key.length === 0) {
    return refuse('the row has no key columns to select on');
  }

  const params = new URLSearchParams();
  // Adminer keys its session on (driver, server, username, db). A URL missing
  // any of them renders the login page — and that page echoes the whole
  // request, key value included, into its own recent-links list, so a *refused*
  // handoff discloses exactly as much as a successful one.
  params.set('pgsql', binding.server);
  params.set('username', binding.username);
  params.set('db', location.database);
  params.set('ns', location.schema);
  params.set('select', table);

  for (const [i, column] of key.entries()) {
    if (!isVisible(column.value)) {
      return refuse(
        `\`${column.name}\` is ${column.value.state === 'masked' ? 'masked at capture' : 'unreadable'}`,
      );
    }
    params.set(`where[${i}][col]`, column.name);
    const [op, text] = operandFor(column.value.text);
    params.set(`where[${i}][op]`, op);
    // `IS NULL` takes no value. Measured: `op` of `=` with an empty `val`
    // matches **no rows** — the `= NULL` bug wearing a URL.
    if (text !== null) params.set(`where[${i}][val]`, text);
  }

  const url = `${binding.origin.replace(/\/$/, '')}/?${params.toString()}`;
  if (url.length > MAX_URL_LENGTH) {
    return refuse(
      `the address is ${url.length} characters, over the ${MAX_URL_LENGTH} this target will emit. ` +
        'A URL truncated by the browser or a proxy addresses a different row without saying so.',
    );
  }
  return { url };
}

function operandFor(text: string | null): [AdminerOp, string | null] {
  return text === null ? ['IS NULL', null] : ['=', text];
}

function refuse(detail: string): AdminerTargetError {
  return { reason: 'target-cannot-address', target: 'adminer-url', detail };
}

/**
 * What the user is told before this is ever opened, and once beside it after.
 *
 * Both strings live here rather than in the surface that shows them, so the
 * terminal and the web page cannot describe the same action differently — which
 * is exactly what happened to masked values when each wrote its own renderer.
 */
export function adminerDisclosure(binding: AdminerBinding): {
  standing: string;
  firstUse: (url: string, alias: string, maskedColumns: ReadonlyArray<string>) => string;
} {
  const where = new URL(binding.origin).host;
  return {
    standing: `Inspect → Adminer at ${where} as ${binding.username} · the key goes into browser history`,
    firstUse: (url, alias, maskedColumns) =>
      [
        `Open in Adminer  ·  not enabled on this machine`,
        ``,
        `  This would open, in your default browser:`,
        ``,
        `    ${url}`,
        ``,
        `  The key is in that URL, and the browser keeps it: history, address-bar`,
        `  autocomplete, and whatever this profile syncs. TupleScope cannot take that`,
        `  back. Adminer connects with its own credentials, as you, and is not bound`,
        maskedColumns.length > 0
          ? `  by maskColumns — it will show ${maskedColumns.join(', ')} in full.`
          : `  by maskColumns.`,
        ``,
        `  \`${alias}\` is a name this repository chose. Bind it yourself, once:`,
        ``,
        `    tuplescope handoff enable adminer-url --as ${alias} \\`,
        `      --origin ${binding.origin} --server ${binding.server} --username ${binding.username}`,
        ``,
        `  Written to ~/.tuplescope/handoff.json, which this repository cannot write.`,
        `  tuplescope handoff list · tuplescope handoff disable`,
      ].join('\n'),
  };
}

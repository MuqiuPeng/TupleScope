/**
 * Whether the two things a run needs are actually there: the backend it sends
 * to, and the database it reads from.
 *
 * This exists as a value rather than as printed output because three surfaces
 * ask the same question and used to answer it differently. `tuplescope status`
 * probed the backend and printed a line; the runtime never probed it at all and
 * echoed `baseUrl` as a string, so the page looked confident about something
 * nobody had checked; and the database was only ever proven as a side effect of
 * `listTables()` succeeding, which no surface said out loud. A rule with three
 * copies drifts, and the copy that drifts is the one that overclaims.
 *
 * `checkedAt` is the load-bearing field. A green dot with no time on it asserts
 * something about *now* on evidence from page load, which is exactly the stale
 * green this product exists to refuse. Every reader of a `Reachability` is
 * expected to show when it was taken.
 */

import { secretsReferencedBy } from './credentials.js';

export interface Reachability {
  /**
   * `not-checked` is a third state on purpose, and never collapses into
   * `unreachable`: "we did not ask" and "we asked and nothing was there" send a
   * reader to different places. An unresolved `${secret:…}` in `baseUrl` is the
   * first, and telling someone to start a server they already started is how
   * they learn to distrust the indicator.
   */
  readonly state: 'reachable' | 'unreachable' | 'not-checked';
  /** The HTTP status, when something answered. Any status counts as answering. */
  readonly status?: number;
  /** Why it could not be reached, or why it was not asked. */
  readonly reason?: string;
  /** What to do about it, when there is something to do. */
  readonly remedy?: string;
  /** ISO-8601, from this module's clock so no caller can forget to stamp it. */
  readonly checkedAt: string;
}

export interface ProbeOptions {
  /** Overridable so a test does not wait, and a caller can be stricter. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Asks the backend for `/` and treats any answer as answering.
 *
 * Deliberately not a health check: a 404 at the root still proves something is
 * listening and speaking HTTP, and demanding a 2xx would report a perfectly
 * good API as down because it has no root route. The payment playground does
 * answer 200 there, and that must not become the requirement.
 */
export async function probeBackend(
  baseUrl: string,
  options: ProbeOptions = {},
): Promise<Reachability> {
  const at = (options.now?.() ?? new Date()).toISOString();
  // Before the fetch: `new URL('/', '${secret:x}')` either throws or, worse,
  // sends the marker somewhere.
  if (secretsReferencedBy({ baseUrl }).length > 0) {
    return {
      state: 'not-checked',
      reason: '`baseUrl` refers to a secret that has not resolved',
      remedy: 'Resolve the secret, then check again.',
      checkedAt: at,
    };
  }
  let target: URL;
  try {
    target = new URL('/', baseUrl);
  } catch {
    return {
      state: 'not-checked',
      reason: `\`baseUrl\` is not a URL: ${baseUrl}`,
      checkedAt: at,
    };
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(target, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { state: 'reachable', status: response.status, checkedAt: at };
  } catch (error) {
    // The driver's sentence is worth keeping — `ECONNREFUSED` and a DNS failure
    // are different problems — but it is never the whole message, because on
    // its own it does not say which URL failed.
    return {
      state: 'unreachable',
      reason: `nothing is listening at ${baseUrl}${causeOf(error)}`,
      remedy: 'Start it, then check again.',
      checkedAt: at,
    };
  }
}

/**
 * The same shape for the database, built from whatever `preflight()` did.
 *
 * Not a second probe: the session already touches the database once, and
 * touching it again would double every page load's cost to say nothing new.
 * This only gives that outcome the shape the backend's has, so a reader can
 * render two indicators with one function instead of two.
 */
export function databaseReachable(
  detail: { tables: number; schema: string },
  options: Pick<ProbeOptions, 'now'> = {},
): Reachability {
  return {
    state: 'reachable',
    reason: `${detail.tables} table${detail.tables === 1 ? '' : 's'} in \`${detail.schema}\``,
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

export function databaseUnreachable(
  detail: { reason: string; remedy?: string },
  options: Pick<ProbeOptions, 'now'> = {},
): Reachability {
  return {
    state: 'unreachable',
    reason: detail.reason,
    ...(detail.remedy ? { remedy: detail.remedy } : {}),
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}

/** `: ECONNREFUSED`, or nothing when the error carries no sentence of its own. */
function causeOf(error: unknown): string {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && code) return `: ${code}`;
  const name = error instanceof Error ? error.name : '';
  // What `AbortSignal.timeout` throws. "TimeoutError" alone reads as a bug in
  // TupleScope rather than as a server that did not answer in time.
  if (name === 'TimeoutError') return ': it did not answer in time';
  return '';
}

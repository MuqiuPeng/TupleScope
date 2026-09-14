/**
 * Resolved credentials, taken back out of everything the runtime says.
 *
 * `server.ts` had the workspace's `scrub` and applied it in one place: the
 * run-job error. Measured (round 3), with the database name set to
 * `${secret:probe}_nope`: `POST /api/run-jobs` answered
 * `database "[secret probe]_nope" does not exist`, while `GET /api/workspace`
 * answered HTTP 500 `database "<the value>_nope" does not exist`, and the
 * level-50 log line for that request carried the value three times, in
 * `err.message`, `err.stack` and `msg`. A thrown error went to Fastify's default
 * error handler, which never saw the scrub, and pino writes its lines itself,
 * not through anything the runtime formats.
 *
 * So this sits where every error body and every log line has to go anyway,
 * not at each call site. A route added later cannot forget it.
 *
 * - Error bodies: an `onSend` hook over every response with status >= 400. Not
 *   `setErrorHandler` alone, because that sees only *thrown* errors, and
 *   routes also *send* error bodies themselves: `/api/reset` answers 502 with the
 *   reset endpoint's own message, which names `resetUrl`, and a `resetUrl` can
 *   carry a `${secret:…}`. One hook covers both kinds, and each body is scrubbed
 *   once. Scrubbing it twice is not harmless: a value that is a substring of
 *   its own placeholder, `[secret db_password]`, would be substituted a second
 *   time inside it.
 * - Log lines: the logger's destination. Pino writes JSON, so a value holding a
 *   `"` or a `\` appears escaped in the line, and substituting the raw value
 *   there would miss it. The line is parsed and each string scrubbed before it
 *   is written again.
 *
 * Success bodies are left alone. They carry the rows a run observed, and a
 * by-value substitution over those would rewrite evidence. `postgres` is a
 * common password and also a common user, database and word.
 */

import type { FastifyInstance } from 'fastify';

export type Scrub = (text: string) => string;

/** Every string inside a JSON-shaped value, scrubbed. Keys are not secrets. */
export function scrubDeep<T>(value: T, scrub: Scrub): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubDeep(item, scrub)]),
    ) as T;
  }
  return value;
}

/** A serialized JSON body or log line, scrubbed string by string. */
function scrubJsonText(text: string, scrub: Scrub): string {
  try {
    return JSON.stringify(scrubDeep(JSON.parse(text) as unknown, scrub));
  } catch {
    // Not JSON after all. The raw substitution is still better than none.
    return scrub(text);
  }
}

/**
 * The logger's destination, for `Fastify({ logger: { stream } })`.
 *
 * Every line pino writes, the default error log included, passes through here
 * on its way to `out`.
 */
export function scrubbingLogStream(
  scrub: Scrub,
  out: { write(chunk: string): unknown } = process.stdout,
): { write(line: string): void } {
  return {
    write(line: string): void {
      const ends = line.endsWith('\n');
      out.write(`${scrubJsonText(ends ? line.slice(0, -1) : line, scrub)}${ends ? '\n' : ''}`);
    },
  };
}

/** Scrubs every error body this app sends, thrown or sent. See the file header. */
export function scrubErrorBodies(app: FastifyInstance, scrub: Scrub): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode < 400) return payload;
    if (typeof payload === 'string') return scrubJsonText(payload, scrub);
    if (Buffer.isBuffer(payload)) return scrubJsonText(payload.toString('utf8'), scrub);
    // A stream: a static file, which carries no resolved value.
    return payload;
  });
}

/**
 * A run's step errors, scrubbed. They reach the page inside a 200, so the
 * error-body hook never sees them, and an engine error can name the request's
 * URL, which is built from `baseUrl`.
 */
export function scrubStepErrors<S extends { error?: unknown }>(
  steps: ReadonlyArray<S>,
  scrub: Scrub,
): S[] {
  return steps.map((step) =>
    step.error === undefined ? step : { ...step, error: scrubDeep(step.error, scrub) },
  );
}

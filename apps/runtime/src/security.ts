/**
 * Local-first does not mean trusted.
 *
 * This process holds write credentials for the user's development database and
 * answers HTTP on localhost. Every page in the user's browser can reach that,
 * and a page that resolves its own hostname to 127.0.0.1 (DNS rebinding) gets
 * past the same-origin policy while it does. So "it's only on localhost" is not
 * a security model, and this file is the one that says so.
 *
 * Four defences, all cheap:
 *   1. bind 127.0.0.1, never 0.0.0.0
 *   2. a random token, minted per start, required on every request
 *   3. Host header allow-list — this is what stops DNS rebinding; checking
 *      Origin alone does not, because the rebound request carries a legitimate
 *      Origin for the attacker's own domain
 *   4. Origin allow-list for browser requests, so a cross-site fetch cannot
 *      ride along even if the token leaks into a log
 *
 * The token may arrive three ways, and all three are needed:
 *
 *   header    what the UI's own fetches send
 *   query     the opening URL, the only thing a person can paste
 *   cookie    everything else the browser asks for on its own
 *
 * The cookie is not a convenience. A page loaded with `?token=` does not pass
 * that token on to its own stylesheet and script tags, so without it the guard
 * answers 401 to the UI's own assets and the page renders as unstyled text with
 * no behaviour. It is SameSite=Strict, so a cross-site request still cannot
 * carry it.
 *
 * Any one of the three matching is enough, and that matters: the token is
 * minted per start, so after a restart the browser is holding a cookie for a
 * token that no longer exists. If the cookie were consulted first — or were
 * allowed to veto — pasting the fresh URL would still be refused, and the only
 * way back in would be to clear site data. A valid query token therefore always
 * wins and replaces the stale cookie.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorisedPage } from './pages.js';

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

const COOKIE = 'tuplescope_token';

/** Reads one cookie without pulling in a parser: the header is `a=1; b=2`. */
function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GuardOptions {
  token: string;
  port: number;
  /** Paths served without a token — only the shell that then supplies one. */
  publicPaths?: ReadonlySet<string>;
}

export function createGuard(options: GuardOptions) {
  const allowedHosts = new Set(
    [...LOOPBACK_HOSTS].flatMap((host) => [`${host}:${options.port}`, host]),
  );
  const allowedOrigins = new Set(
    ['127.0.0.1', 'localhost'].map((host) => `http://${host}:${options.port}`),
  );

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 3. Host must be loopback. A rebound name like `evil.example` fails here
    //    even though the packet genuinely arrived on 127.0.0.1.
    const host = request.headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      await reply.status(403).send({
        error: 'BAD_HOST',
        message: `Refusing a request addressed to \`${host ?? '(none)'}\`. TupleScope answers only to localhost.`,
      });
      return;
    }

    // 4. A browser tells us where it came from; anything else is not welcome.
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin.toLowerCase())) {
      await reply.status(403).send({
        error: 'BAD_ORIGIN',
        message: `\`${origin}\` is not allowed to talk to TupleScope.`,
      });
      return;
    }

    if (options.publicPaths?.has(request.url.split('?')[0] ?? '')) return;

    // 2. The token. Any one of the three sources matching is enough — a stale
    //    cookie from a previous run must not shadow a freshly pasted URL.
    const rawHeader = request.headers['x-tuplescope-token'];
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const query = (request.query as { token?: string } | undefined)?.token;
    const cookie = cookieToken(request.headers.cookie);

    const matched = [header, query, cookie].some(
      (candidate) => candidate !== undefined && tokenMatches(candidate, options.token),
    );

    if (matched && query !== undefined) {
      // Arrived by URL: hand the browser a cookie so the page's own stylesheet,
      // script and later fetches are not each refused — and so a cookie left
      // over from an earlier run is overwritten rather than left to rot.
      void reply.header(
        'set-cookie',
        `${COOKIE}=${options.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      );
    }

    if (!matched) {
      // A person who typed the address into a browser gets a page that says
      // where the token is. A fetch() gets JSON it can act on. Same refusal,
      // told in the language the caller speaks.
      if (request.headers.accept?.includes('text/html')) {
        await reply.status(401).type('text/html; charset=utf-8').send(unauthorisedPage(options.port));
        return;
      }
      await reply.status(401).send({
        error: 'UNAUTHORISED',
        message:
          'Missing or wrong access token. Run `tuplescope url` for the URL of this ' +
          'instance, token and all.',
      });
      return;
    }
  };
}

/**
 * The response headers this page ships with, strict because it can afford to be.
 *
 * Measured before writing this: the page carries **no** inline event handlers,
 * no `<script>` without a `src`, no `<style>` element, no `style` attribute, no
 * external origin anywhere, and every `fetch` is same-origin. So `'self'` is
 * enough everywhere and `'unsafe-inline'` is needed nowhere — which is the only
 * version of this header worth having. The panel-mods design assumed otherwise
 * ("it currently uses inline handlers freely, so this is not a one-line
 * addition"); that was true of an earlier page and is not true of this one.
 *
 * `default-src 'none'` is the load-bearing line. Every fetch destination this
 * page does not use — media, object, manifest, worker — is denied by falling
 * back to it rather than by being listed, so a directive nobody thought of is
 * closed rather than open.
 *
 * `connect-src 'self'` is also the prerequisite panel mods are waiting on: a
 * Worker inherits its creator's policy, and inside a Worker that directive is a
 * *complete* statement about the network because a Worker has no navigation and
 * no elements to build. See docs/panel-mods-design.md §1.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    // No `img-src`, no `font-src`: measured, the page loads neither, and
    // `default-src 'none'` already covers them. An allowance nothing uses is
    // how a policy loosens — the first image added here should produce a
    // console error naming the directive, so widening it is a decision.
    // Nothing here navigates or submits, and a page that cannot be framed
    // cannot be clickjacked into pressing Run.
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  // The token lives in the URL until the page strips it. Referrer-Policy keeps
  // it out of any request that leaves, and nothing here leaves.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

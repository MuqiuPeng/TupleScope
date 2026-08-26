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
 * no behaviour. It is set the first time a valid query token arrives, and it is
 * SameSite=Strict, so a cross-site request still cannot carry it.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorisedPage } from './pages.js';

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

const COOKIE = 'statescope_token';

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
        message: `Refusing a request addressed to \`${host ?? '(none)'}\`. StateScope answers only to localhost.`,
      });
      return;
    }

    // 4. A browser tells us where it came from; anything else is not welcome.
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin.toLowerCase())) {
      await reply.status(403).send({
        error: 'BAD_ORIGIN',
        message: `\`${origin}\` is not allowed to talk to StateScope.`,
      });
      return;
    }

    if (options.publicPaths?.has(request.url.split('?')[0] ?? '')) return;

    // 2. The token, from whichever of the three places it arrived in.
    const header = request.headers['x-statescope-token'];
    const query = (request.query as { token?: string } | undefined)?.token;
    const provided =
      (Array.isArray(header) ? header[0] : header) ??
      cookieToken(request.headers.cookie) ??
      query;

    if (provided && query && tokenMatches(provided, options.token)) {
      // Arrived by URL: hand the browser a cookie so the page's own stylesheet,
      // script and later fetches are not each refused.
      void reply.header(
        'set-cookie',
        `${COOKIE}=${options.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      );
    }

    if (!provided || !tokenMatches(provided, options.token)) {
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
          'Missing or wrong access token. Open the URL the runtime printed at startup, ' +
          'or run `localruntime logs statescope runtime | grep token=` to recover it.',
      });
      return;
    }
  };
}

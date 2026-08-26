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
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorisedPage } from './pages.js';

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
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

    // 2. The token. Query string is accepted only for the initial page load,
    //    which then keeps it in memory and uses the header from that point on.
    const header = request.headers['x-statescope-token'];
    const query = (request.query as { token?: string } | undefined)?.token;
    const provided = (Array.isArray(header) ? header[0] : header) ?? query;
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

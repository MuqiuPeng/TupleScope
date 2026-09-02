/**
 * The guard has to refuse the right things *and* let the UI load.
 *
 * The second half is not obvious and cost a working UI once already: a page
 * opened with `?token=` does not pass that token to its own `<link>` and
 * `<script>` tags, so a guard that only reads the header and the query answers
 * 401 to its own stylesheet. The page then renders as unstyled text with no
 * behaviour, and every API check still passes when you test with curl.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createGuard, mintToken, SECURITY_HEADERS } from './security.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const PORT = 7420;

interface Captured {
  status?: number;
  body?: { error?: string; message?: string } | undefined;
  headers: Record<string, string>;
  contentType?: string;
}

function call(options: {
  url?: string;
  host?: string | undefined;
  origin?: string;
  header?: string;
  cookie?: string;
  query?: Record<string, string>;
  accept?: string;
}): Promise<Captured> {
  const captured: Captured = { headers: {} };
  const reply = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    type(value: string) {
      captured.contentType = value;
      return this;
    },
    header(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    async send(body: unknown) {
      captured.body = body as Captured['body'];
      return this;
    },
  } as unknown as FastifyReply;

  const request = {
    url: options.url ?? '/api/workspace',
    query: options.query ?? {},
    headers: {
      // `'host' in options` rather than a truthiness check: passing
      // `host: undefined` has to mean "send no Host header", not "use the default".
      host: 'host' in options ? options.host : `127.0.0.1:${PORT}`,
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.header ? { 'x-tuplescope-token': options.header } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.accept ? { accept: options.accept } : {}),
    },
  } as unknown as FastifyRequest;

  const guard = createGuard({ token: TOKEN, port: PORT, publicPaths: new Set(['/health']) });
  return guard(request, reply).then(() => captured);
}

const allowed = (c: Captured): boolean => c.status === undefined;

describe('createGuard', () => {
  it('accepts the token from the header', async () => {
    assert.ok(allowed(await call({ header: TOKEN })));
  });

  it('accepts it from the query, and hands back a cookie', async () => {
    // Without this cookie the page's own assets are refused and the UI is blank.
    const result = await call({ url: '/', query: { token: TOKEN } });
    assert.ok(allowed(result));
    const cookie = result.headers['set-cookie'];
    assert.ok(cookie, 'a cookie should be set');
    assert.match(cookie!, /^tuplescope_token=/);
    assert.match(cookie!, /HttpOnly/);
    assert.match(cookie!, /SameSite=Strict/);
    assert.match(cookie!, /Path=\//);
  });

  it('accepts a request carrying only that cookie', async () => {
    // This is every stylesheet, script and image the page asks for.
    assert.ok(allowed(await call({ url: '/styles.css', cookie: `tuplescope_token=${TOKEN}` })));
    assert.ok(allowed(await call({ url: '/app.js', cookie: `tuplescope_token=${TOKEN}` })));
  });

  it('finds its cookie among others', async () => {
    assert.ok(
      allowed(await call({ cookie: `other=1; tuplescope_token=${TOKEN}; another=2` })),
    );
  });

  it('does not set a cookie for a wrong query token', async () => {
    const result = await call({ url: '/', query: { token: 'wrong' } });
    assert.equal(result.status, 401);
    assert.equal(result.headers['set-cookie'], undefined);
  });

  it('refuses a request with no token at all', async () => {
    const result = await call({});
    assert.equal(result.status, 401);
    assert.equal(result.body?.error, 'UNAUTHORISED');
  });

  it('lets a fresh URL in past a cookie from a previous run', async () => {
    // The token is minted per start, so after a restart the browser is holding
    // a cookie for a token that no longer exists. If that could veto, pasting
    // the new URL would still be refused and the only way in would be to clear
    // site data.
    const result = await call({
      url: '/',
      query: { token: TOKEN },
      cookie: 'tuplescope_token=token-from-the-previous-run',
    });
    assert.ok(allowed(result), 'the fresh query token should win');
    // ...and the stale cookie is overwritten, not left to rot.
    assert.match(result.headers['set-cookie'] ?? '', new RegExp(`^tuplescope_token=${TOKEN};`));
  });

  it('lets a header through past a stale cookie too', async () => {
    assert.ok(allowed(await call({ header: TOKEN, cookie: 'tuplescope_token=stale' })));
  });

  it('refuses when every source is wrong', async () => {
    const result = await call({
      header: 'no',
      cookie: 'tuplescope_token=nope',
      query: { token: 'nah' },
    });
    assert.equal(result.status, 401);
    assert.equal(result.headers['set-cookie'], undefined);
  });

  it('refuses a wrong cookie', async () => {
    assert.equal((await call({ cookie: 'tuplescope_token=nope' })).status, 401);
  });

  it('lets a public path through with nothing', async () => {
    assert.ok(allowed(await call({ url: '/health' })));
  });

  it('refuses a rebound Host before it looks at the token', async () => {
    // The packet really did arrive on 127.0.0.1; the Host header is what gives
    // a DNS rebinding attack away.
    const result = await call({ host: 'evil.example', header: TOKEN });
    assert.equal(result.status, 403);
    assert.equal(result.body?.error, 'BAD_HOST');
  });

  it('accepts every loopback spelling', async () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, '127.0.0.1', 'localhost']) {
      assert.ok(allowed(await call({ host, header: TOKEN })), `${host} should be allowed`);
    }
  });

  it('refuses a missing Host', async () => {
    assert.equal((await call({ host: undefined, header: TOKEN })).status, 403);
  });

  it('refuses a cross-site Origin', async () => {
    const result = await call({ origin: 'https://evil.example', header: TOKEN });
    assert.equal(result.status, 403);
    assert.equal(result.body?.error, 'BAD_ORIGIN');
  });

  it('allows the UI’s own Origin', async () => {
    assert.ok(allowed(await call({ origin: `http://127.0.0.1:${PORT}`, header: TOKEN })));
  });

  it('answers a browser in HTML and a fetch in JSON', async () => {
    // "Open the URL the runtime printed" is useless to someone already looking
    // at a browser, so they get a page telling them where the token lives.
    const page = await call({ url: '/', accept: 'text/html,application/xhtml+xml' });
    assert.equal(page.status, 401);
    assert.match(page.contentType ?? '', /text\/html/);

    const api = await call({ url: '/api/runs' });
    assert.equal(api.status, 401);
    assert.equal(api.contentType, undefined);
    // The message must point at something that is right whoever started the
    // process. Reading a supervisor's log is not: it happily reports the token
    // of an instance that has already exited.
    assert.match(api.body?.message ?? '', /tuplescope url/);
  });
});

describe('mintToken', () => {
  it('is long, url-safe and different every time', () => {
    const a = mintToken();
    const b = mintToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 40);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
  });
});

describe('SECURITY_HEADERS', () => {
  const csp = SECURITY_HEADERS['content-security-policy']!;
  const directive = (name: string): string | undefined =>
    csp.split('; ').find((part) => part.startsWith(`${name} `) || part === name);

  it('closes by default, so a directive nobody thought of is denied', () => {
    // The load-bearing line. Every destination this page does not use — media,
    // object, manifest, worker — falls back to `none` rather than being listed,
    // which is what makes an unlisted one closed instead of open.
    assert.equal(directive('default-src'), "default-src 'none'");
  });

  it('never allows inline or eval, anywhere', () => {
    // Measured before this header was written: the page carries no inline
    // handler, no `<script>` without a src, no `<style>` and no `style`
    // attribute. So `unsafe-inline` buys nothing and would cost everything —
    // and `unsafe-eval` would make `connect-src` meaningless in a Worker, which
    // is the whole reason panel mods are waiting on this.
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|unsafe-hashes/);
  });

  it('permits no origin but this one', () => {
    // A single external host in here would be a route out for anything running
    // on the page, which for a page holding database rows is the thing to stop.
    assert.doesNotMatch(csp, /https?:|\*|data:|blob:/);
    for (const name of ['script-src', 'style-src', 'connect-src']) {
      assert.equal(directive(name), `${name} 'self'`, name);
    }
  });

  it('lists no directive the page does not use', () => {
    // Measured: no image, no font, no media anywhere in the page. Each is
    // covered by `default-src 'none'`, and an allowance nothing uses is how a
    // policy loosens without anyone deciding to loosen it.
    for (const unused of ['img-src', 'font-src', 'media-src', 'object-src']) {
      assert.equal(directive(unused), undefined, unused);
    }
  });

  it('keeps connect-src to self, which is what a panel mod Worker will inherit', () => {
    // A Worker inherits its creator's policy, and inside a Worker `connect-src`
    // is a complete statement about the network — there is no navigation and no
    // element to build. docs/panel-mods-design.md §1.
    assert.equal(directive('connect-src'), "connect-src 'self'");
  });

  it('cannot be framed, and cannot navigate or submit', () => {
    assert.equal(directive('frame-ancestors'), "frame-ancestors 'none'");
    assert.equal(directive('base-uri'), "base-uri 'none'");
    assert.equal(directive('form-action'), "form-action 'none'");
    assert.equal(SECURITY_HEADERS['x-frame-options'], 'DENY');
  });

  it('sends no referrer, because the token starts life in the URL', () => {
    assert.equal(SECURITY_HEADERS['referrer-policy'], 'no-referrer');
  });
});

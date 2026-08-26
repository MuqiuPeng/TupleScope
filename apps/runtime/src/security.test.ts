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
import { createGuard, mintToken } from './security.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const PORT = 7420;

interface Captured {
  status?: number;
  body?: { error?: string; message?: string };
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
      ...(options.header ? { 'x-statescope-token': options.header } : {}),
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
    assert.match(cookie!, /^statescope_token=/);
    assert.match(cookie!, /HttpOnly/);
    assert.match(cookie!, /SameSite=Strict/);
    assert.match(cookie!, /Path=\//);
  });

  it('accepts a request carrying only that cookie', async () => {
    // This is every stylesheet, script and image the page asks for.
    assert.ok(allowed(await call({ url: '/styles.css', cookie: `statescope_token=${TOKEN}` })));
    assert.ok(allowed(await call({ url: '/app.js', cookie: `statescope_token=${TOKEN}` })));
  });

  it('finds its cookie among others', async () => {
    assert.ok(
      allowed(await call({ cookie: `other=1; statescope_token=${TOKEN}; another=2` })),
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
      cookie: 'statescope_token=token-from-the-previous-run',
    });
    assert.ok(allowed(result), 'the fresh query token should win');
    // ...and the stale cookie is overwritten, not left to rot.
    assert.match(result.headers['set-cookie'] ?? '', new RegExp(`^statescope_token=${TOKEN};`));
  });

  it('lets a header through past a stale cookie too', async () => {
    assert.ok(allowed(await call({ header: TOKEN, cookie: 'statescope_token=stale' })));
  });

  it('refuses when every source is wrong', async () => {
    const result = await call({
      header: 'no',
      cookie: 'statescope_token=nope',
      query: { token: 'nah' },
    });
    assert.equal(result.status, 401);
    assert.equal(result.headers['set-cookie'], undefined);
  });

  it('refuses a wrong cookie', async () => {
    assert.equal((await call({ cookie: 'statescope_token=nope' })).status, 401);
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
    assert.match(api.body?.message ?? '', /statescope url/);
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

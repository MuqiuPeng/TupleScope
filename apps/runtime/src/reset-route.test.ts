/**
 * `POST /api/reset` — the route, over a real Fastify, with the same headers the
 * page sends.
 *
 * This file exists because of a bug that only appeared in a browser. The route
 * takes no parameters, so it was tested with `curl -X POST` and passed. The
 * page's own `api()` helper sets `content-type: application/json` on every
 * request, and Fastify refuses an empty body under that header — so the button
 * failed with `Body cannot be empty`, on a route that had been "tested".
 *
 * Testing a route with a client that sends different headers from the real one
 * is testing a different route.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerResetRoute } from './reset-route.js';

async function appWith(options: Parameters<typeof registerResetRoute>[1]) {
  const app = Fastify();
  registerResetRoute(app, options);
  await app.ready();
  return app;
}

/** Exactly what the page sends: JSON content-type, empty object body. */
const asThePageSends = { method: 'POST' as const, url: '/api/reset', headers: { 'content-type': 'application/json' }, payload: '{}' };

describe('POST /api/reset', () => {
  it('accepts the request the page actually makes', async () => {
    let called = 0;
    const app = await appWith({ reset: async () => { called += 1; }, isRunning: () => false });
    const response = await app.inject(asThePageSends);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(called, 1);
    assert.equal(JSON.parse(response.body).ok, true);
    await app.close();
  });

  it('also accepts a request with no body at all', async () => {
    // `curl -X POST` sends neither, and a route that works for one client and
    // not the other is a route nobody can reason about.
    const app = await appWith({ reset: async () => {}, isRunning: () => false });
    const response = await app.inject({ method: 'POST', url: '/api/reset' });
    assert.equal(response.statusCode, 200, response.body);
    await app.close();
  });

  it('refuses when the workspace declares no reset', async () => {
    const app = await appWith({ isRunning: () => false });
    const response = await app.inject(asThePageSends);
    assert.equal(response.statusCode, 409);
    assert.match(JSON.parse(response.body).message, /no `resetUrl`/);
    await app.close();
  });

  it('refuses while a run is in flight', async () => {
    // Resetting under a capture window would pull the state out from under it,
    // and every change it went on to report would be a lie.
    let called = 0;
    const app = await appWith({ reset: async () => { called += 1; }, isRunning: () => true });
    const response = await app.inject(asThePageSends);
    assert.equal(response.statusCode, 409);
    assert.equal(called, 0, 'it must not reset anyway');
    assert.match(JSON.parse(response.body).message, /run is in progress/i);
    await app.close();
  });

  it('reports a failing reset rather than claiming success', async () => {
    const app = await appWith({
      reset: async () => { throw new Error('Could not reach the reset endpoint at http://x'); },
      isRunning: () => false,
    });
    const response = await app.inject(asThePageSends);
    assert.equal(response.statusCode, 502);
    assert.match(JSON.parse(response.body).message, /Could not reach/);
    await app.close();
  });
});

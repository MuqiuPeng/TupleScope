/**
 * `GET /api/health`, what `/api/workspace` reports, and the refusal in front of
 * a run — over a real Fastify, the way the reset and assertion routes are tested.
 *
 * Three things here are behaviour and not decoration, and each has a test whose
 * red state is worth reading:
 *
 *   `checkedAt` reaches the page. An indicator with no time on it asserts
 *   something about *now* from evidence taken at page load, and this product
 *   exists to refuse exactly that.
 *
 *   'not-checked' stays 'not-checked'. "We did not ask" and "we asked and
 *   nothing was there" send a reader to different places.
 *
 *   a focus poll does not list tables, and a run does not start without a
 *   database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import type { Reachability } from '@tuplescope/workspace';
import { registerHealthRoute, runRefusal, workspaceReachability } from './health-route.js';

/** A fixed clock, so `checkedAt` is an assertion and not a "looks present". */
const AT = '2026-09-13T09:15:00.000Z';
const now = (): Date => new Date(AT);

/** The resolved password. Same shape of leak `scrub.test.ts` measured. */
const VALUE = 'zq7Kprobe4tsx';
const scrub = (text: string): string => text.split(VALUE).join('[secret db_password]');

/** What the driver throws, fields and all, when the database is not there. */
function driverError(): Error {
  return Object.assign(new Error(`database "${VALUE}_nope" does not exist`), {
    code: '3D000',
    severity: 'FATAL',
  });
}

/** What `preflight()` throws: the same failure, carrying a remedy. */
function workspaceError(): Error {
  return Object.assign(new Error('Could not reach the database for workspace `shop`: ECONNREFUSED'), {
    code: 'DATABASE_UNREACHABLE',
    remedy: 'Check `database.connectionString` in /w/tuplescope.yaml, and that the database is running.',
  });
}

const answered = async (): Promise<Reachability> => ({
  state: 'reachable',
  status: 204,
  checkedAt: AT,
});

function healthApp(options: {
  pingDatabase: () => Promise<{ tables: number; schema: string }>;
  probe?: (baseUrl: string) => Promise<Reachability>;
  baseUrl?: string;
}) {
  const app = Fastify();
  registerHealthRoute(app, {
    pingDatabase: options.pingDatabase,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:4000',
    scrub,
    ...(options.probe ? { probe: options.probe } : {}),
    now,
  });
  return app;
}

async function health(app: ReturnType<typeof healthApp>) {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  return { response, body: JSON.parse(response.body) as { database: Reachability; backend: Reachability } };
}

describe('GET /api/health', () => {
  it('answers both questions, each stamped with when it was asked', async () => {
    const app = healthApp({
      pingDatabase: async () => ({ tables: 35, schema: 'public' }),
      probe: answered,
    });
    const { response, body } = await health(app);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(body.database.state, 'reachable');
    assert.equal(body.database.reason, '35 tables in `public`');
    assert.equal(body.backend.state, 'reachable');
    assert.equal(body.backend.status, 204);
    // The load-bearing field. A state with no time on it is the stale green
    // this route exists to replace.
    assert.equal(body.database.checkedAt, AT);
    assert.equal(body.backend.checkedAt, AT);
    await app.close();
  });

  it('touches the database once, and with the cheap question', async () => {
    // The page polls this on every window focus, so what it costs is part of
    // what it is. `ping()` is one row of two scalars; `listTables()` returns a
    // row per table, which is a page-load cost.
    const asked: string[] = [];
    const adapter = {
      ping: async () => {
        asked.push('ping');
        return { tables: 2, schema: 'public' };
      },
      listTables: async () => {
        asked.push('listTables');
        return ['carts', 'orders'];
      },
    };
    const app = Fastify();
    registerHealthRoute(app, {
      // Wired as `server.ts` wires it.
      pingDatabase: () => adapter.ping(),
      baseUrl: 'http://127.0.0.1:4000',
      scrub,
      probe: answered,
      now,
    });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(asked, ['ping']);
    await app.close();
  });

  it('reports a database that is down instead of failing the request', async () => {
    // 200, because the states *are* the report: a non-200 here would make the
    // page's own fetch the thing that failed and leave nothing to render.
    const app = healthApp({
      pingDatabase: async () => { throw workspaceError(); },
      probe: answered,
    });
    const { response, body } = await health(app);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(body.database.state, 'unreachable');
    assert.match(body.database.reason ?? '', /Could not reach the database for workspace `shop`/);
    // The remedy the thrower knew, naming the file to edit — not a generic one.
    assert.match(body.database.remedy ?? '', /database\.connectionString/);
    assert.equal(body.database.checkedAt, AT);
    await app.close();
  });

  it('says what to do when whatever threw did not', async () => {
    // A driver error carries a sentence and no remedy; a bare code on screen
    // sends a reader to a search engine.
    const app = healthApp({
      pingDatabase: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); },
      probe: answered,
    });
    const { body } = await health(app);
    assert.equal(body.database.state, 'unreachable');
    assert.match(body.database.remedy ?? '', /Start the database for this workspace/);
    await app.close();
  });

  it('keeps a resolved password out of a body nothing else scrubs', async () => {
    // These travel inside a 200, where `scrubErrorBodies` never looks. Measured
    // leak (scrub.ts, round 3): `database "<the value>_nope" does not exist`
    // from the driver, and a `baseUrl` people really do write credentials into.
    const app = healthApp({
      pingDatabase: async () => { throw driverError(); },
      probe: async () => ({
        state: 'unreachable',
        reason: `nothing is listening at http://api:${VALUE}@127.0.0.1:4000: ECONNREFUSED`,
        remedy: 'Start it, then check again.',
        checkedAt: AT,
      }),
    });
    const { response, body } = await health(app);
    assert.ok(!response.body.includes(VALUE), response.body);
    assert.equal(body.database.reason, 'database "[secret db_password]_nope" does not exist');
    assert.match(body.backend.reason ?? '', /http:\/\/api:\[secret db_password\]@127/);
    await app.close();
  });

  it('never turns "we did not ask" into "it is down"', async () => {
    // The real probe, on a `baseUrl` that is not a URL — it cannot be fetched,
    // so nobody asked anything, so nothing is known about the backend. Reporting
    // that as unreachable tells someone to start a server that may well be
    // running, and one of those is how a person learns to ignore the indicator.
    const app = healthApp({
      pingDatabase: async () => ({ tables: 1, schema: 'public' }),
      baseUrl: 'not a url',
    });
    const { body } = await health(app);
    assert.equal(body.backend.state, 'not-checked');
    assert.match(body.backend.reason ?? '', /is not a URL/);
    assert.equal(body.backend.checkedAt, AT);
    await app.close();
  });
});

describe('what GET /api/workspace reports', () => {
  it('lists the tables and reports the count it listed', async () => {
    const result = await workspaceReachability({
      adapter: {
        ping: async () => ({ tables: 3, schema: 'shop' }),
        listTables: async () => ['carts', 'orders', 'payments'],
      },
      baseUrl: 'http://127.0.0.1:4000',
      scrub,
      probe: answered,
      now,
    });
    assert.deepEqual(result.tables, ['carts', 'orders', 'payments']);
    // The sentence beside the indicator counts the list the page renders.
    assert.equal(result.database.reason, '3 tables in `shop`');
    assert.equal(result.database.checkedAt, AT);
  });

  it('answers with no tables rather than refusing the page when the database is down', async () => {
    // This route used to answer 503 here, which made the whole page a fatal
    // screen — including the scenario list and the stored runs, neither of which
    // needs a database, and including the indicator that would have explained it.
    const result = await workspaceReachability({
      adapter: {
        ping: async () => { throw driverError(); },
        listTables: async () => { throw driverError(); },
      },
      baseUrl: 'http://127.0.0.1:4000',
      scrub,
      probe: answered,
      now,
    });
    assert.deepEqual(result.tables, []);
    assert.equal(result.database.state, 'unreachable');
    assert.ok(!JSON.stringify(result).includes(VALUE), JSON.stringify(result));
    // The backend is still reported: one dependency being down must not take
    // the other one's answer with it.
    assert.equal(result.backend.state, 'reachable');
  });
});

describe('the refusal in front of a run', () => {
  it('lets a run through when the database answers', async () => {
    const refusal = await runRefusal({
      pingDatabase: async () => ({ tables: 4, schema: 'public' }),
      workspace: 'shop',
      now,
    });
    assert.equal(refusal, undefined);
  });

  it('refuses before any work, naming the workspace, the reason and the remedy', async () => {
    const refusal = await runRefusal({
      pingDatabase: async () => { throw workspaceError(); },
      workspace: 'shop',
      now,
    });
    assert.ok(refusal, 'a run with no database must be refused');
    assert.equal(refusal.status, 503);
    assert.equal(refusal.body.error, 'DATABASE_UNREACHABLE');
    assert.match(refusal.body.message, /workspace `shop`/);
    assert.match(refusal.body.message, /could not observe what it writes/);
    assert.match(refusal.body.remedy ?? '', /database\.connectionString/);
    // Carried whole, so the page can move its indicator from the refusal itself.
    assert.equal(refusal.body.database.state, 'unreachable');
    assert.equal(refusal.body.database.checkedAt, AT);
  });

  // What this file used to end with was a hand-built Fastify route carrying a
  // copy of `server.ts`'s handler, which meant no line of `server.ts` could make
  // it fail — and the ordering it claimed to pin was the ordering that was
  // wrong. The rule now lives in `run-admission.ts` and is tested there, against
  // the code the route actually runs.
});

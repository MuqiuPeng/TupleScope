/**
 * Whether the reachability answer a reader is shown is one they can trust.
 *
 * Two of these tests exist because of what a *later* reader will think is an
 * improvement. `probeBackend` treating a 404 as reachable looks like a missing
 * `response.ok`, and the third `not-checked` state looks like an `unreachable`
 * with extra steps. Both would ship as tidying and both would make an indicator
 * lie, so they are pinned here with the reason attached.
 *
 * Every constructor is also checked for `checkedAt`, together, in one place: an
 * indicator with no time on it asserts something about *now* using evidence
 * from whenever the page loaded, and refusing that stale green is the reason
 * this module is a value instead of three printed lines.
 *
 * No real clock and no real network — `now` and `fetch` are injected
 * throughout, so nothing here is timing-dependent and nothing here can reach
 * out of the process.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { secretMarker } from '@tuplescope/secrets';
import { SECRET_NONCE } from './config.js';
import { databaseReachable, databaseUnreachable, probeBackend } from './reachability.js';

const AT = '2026-03-04T11:22:33.000Z';
const now = () => new Date(AT);

/**
 * A `fetch` that records what it was handed and answers however the test says.
 *
 * The recording is the point in the `not-checked` cases, where the assertion is
 * that it was never reached at all.
 */
function recordingFetch(respond: () => Promise<Response>) {
  const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), signal: init?.signal });
    return respond();
  };
  return { calls, fetch };
}

const answering = (status: number) => recordingFetch(async () => new Response(null, { status }));
const failing = (error: unknown) =>
  recordingFetch(async () => {
    throw error;
  });

/**
 * What a refused connection actually looks like coming out of `fetch`.
 *
 * Measured on Node 22, against a port bound and then closed so nothing could be
 * listening: `TypeError: fetch failed` whose `cause` is an `Error` carrying
 * `code: 'ECONNREFUSED'`. The code hangs off the cause, not off the error, which
 * is the whole reason `causeOf` looks where it looks.
 */
const connectionRefused = () =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7421'), { code: 'ECONNREFUSED' }),
  });

/**
 * What `AbortSignal.timeout` actually aborts a `fetch` with.
 *
 * Measured against a server that accepted the connection and never answered: a
 * `DOMException` named `TimeoutError`, carrying no `cause` at all. So the name
 * branch in `causeOf` is not a fallback for exotic drivers — it is the only
 * thing that fires on the ordinary timeout.
 */
const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

/**
 * A `baseUrl` holding a reference the resolve pass never turned into a value.
 *
 * Built with the real `SECRET_NONCE` rather than a test nonce of its own,
 * because `probeBackend` calls `secretsReferencedBy({ baseUrl })` with no nonce
 * argument and so reads markers of this process's nonce. A marker minted with
 * any other nonce is correctly invisible to it, and a test using one would pass
 * while asserting nothing.
 *
 * The credential sits in the password position deliberately. Measured:
 * `new URL('/', 'http://app:<marker>@127.0.0.1:7421')` parses, and the marker
 * survives percent-encoded into `href` as
 * `http://app:%00tuplescope%3A…%00@127.0.0.1:7421/` — so with the guard removed
 * this is not a harmless wasted request, it is the unresolved reference being
 * handed to the network as a credential.
 */
const UNRESOLVED_PASSWORD_URL = `http://app:${secretMarker(SECRET_NONCE, 'api_token')}@127.0.0.1:7421`;

/** Marker-bearing *and* unparseable: NUL is a forbidden host code point. */
const UNRESOLVED_HOST_URL = `https://${secretMarker(SECRET_NONCE, 'tenant_host')}.internal.test`;

describe('probing a backend that answers', () => {
  it('is reachable, and carries the status through', async () => {
    const backend = answering(200);
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: backend.fetch, now });

    assert.equal(result.state, 'reachable');
    assert.equal(result.status, 200);
  });

  it('is still reachable on a 404, because a 404 proves something is listening', async () => {
    // The one most likely to be "fixed" into `response.ok`. An API with no root
    // route answers 404 at `/` and is in perfect health; reporting it as down
    // teaches its owner to ignore the indicator, which costs more than the
    // check is worth. Any answer at all is the evidence being gathered here —
    // this is a liveness probe, not a health check.
    const backend = answering(404);
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: backend.fetch, now });

    assert.equal(result.state, 'reachable');
    assert.equal(result.status, 404);
    assert.equal(result.reason, undefined);
  });

  it('is still reachable on a 500, for the same reason', async () => {
    // A backend that is up and broken is a different problem from a backend
    // that is not there, and only the second one is answered by "start it".
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: answering(500).fetch, now });

    assert.equal(result.state, 'reachable');
    assert.equal(result.status, 500);
  });

  it('asks for the root, whatever path the baseUrl carries', async () => {
    // `new URL('/', baseUrl)`. A workspace whose baseUrl is `…/api/v2` should
    // not have the probe depend on `/api/v2` existing as a route.
    const backend = answering(200);
    await probeBackend('http://127.0.0.1:7421/api/v2', { fetch: backend.fetch, now });

    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0]?.url, 'http://127.0.0.1:7421/');
  });

  it('gives the request a deadline', async () => {
    // Without a signal the probe inherits no timeout, and a server that accepts
    // the connection and never answers hangs the surface that asked.
    const backend = answering(200);
    await probeBackend('http://127.0.0.1:7421', { fetch: backend.fetch, now, timeoutMs: 50 });

    assert.ok(backend.calls[0]?.signal instanceof AbortSignal);
  });
});

describe('probing a backend that does not answer', () => {
  it('is unreachable, names the baseUrl, and says what to do', async () => {
    // The driver's sentence never says which URL failed, and a surface showing
    // two indicators needs to know which one this was about.
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: failing(new Error('boom')).fetch, now });

    assert.equal(result.state, 'unreachable');
    assert.match(result.reason ?? '', /nothing is listening at http:\/\/127\.0\.0\.1:7421/);
    assert.equal(result.remedy, 'Start it, then check again.');
    assert.equal(result.status, undefined);
  });

  it('keeps the ECONNREFUSED off the cause, because a refusal is not a DNS failure', async () => {
    // "Nothing is listening" and "that name does not resolve" send someone to
    // different files, and the code is the only part of the error that separates
    // them.
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: failing(connectionRefused()).fetch, now });

    assert.equal(result.state, 'unreachable');
    assert.match(result.reason ?? '', /ECONNREFUSED/);
    assert.match(result.reason ?? '', /nothing is listening at http:\/\/127\.0\.0\.1:7421: ECONNREFUSED/);
  });

  it('reads a timeout as a server that did not answer in time, not as a TupleScope bug', async () => {
    // Surfacing the bare `TimeoutError` sends someone to this repo's issues for
    // a slow server of their own. The sentence has to be about their server.
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: failing(timedOut()).fetch, now });

    assert.equal(result.state, 'unreachable');
    assert.match(result.reason ?? '', /it did not answer in time/);
    assert.doesNotMatch(result.reason ?? '', /TimeoutError/);
    assert.doesNotMatch(result.reason ?? '', /DOMException|abort/i);
  });
});

describe('probing a backend nobody can ask about yet', () => {
  it('is not-checked on an unresolved secret, and never becomes unreachable', async () => {
    // The invariant, stated as a test: "we did not ask" must not render as "we
    // asked and nothing was there". Telling someone to start a server they
    // already started is how they learn to distrust the indicator — the thing
    // to fix is the secret, and the remedy has to say so.
    const backend = answering(200);
    const result = await probeBackend(UNRESOLVED_PASSWORD_URL, { fetch: backend.fetch, now });

    assert.equal(result.state, 'not-checked');
    assert.notEqual(result.state, 'unreachable');
    assert.match(result.reason ?? '', /secret that has not resolved/);
    assert.match(result.remedy ?? '', /Resolve the secret/);
  });

  it('sends nothing anywhere when the baseUrl holds an unresolved reference', async () => {
    // Security, not tidiness. This baseUrl parses, and the marker survives into
    // the URL that would be fetched — so a probe here transmits the unresolved
    // reference as a password to whatever is on the other end.
    const backend = answering(200);
    await probeBackend(UNRESOLVED_PASSWORD_URL, { fetch: backend.fetch, now });

    assert.deepEqual(backend.calls, []);
  });

  it('keeps the marker out of its own output', async () => {
    // The reason is shown to a human and written to logs; it must describe the
    // reference without quoting it.
    const result = await probeBackend(UNRESOLVED_PASSWORD_URL, { fetch: answering(200).fetch, now });

    assert.doesNotMatch(result.reason ?? '', /tuplescope:/);
    assert.doesNotMatch(result.remedy ?? '', /tuplescope:/);
    assert.ok(!(result.reason ?? '').includes(UNRESOLVED_PASSWORD_URL));
  });

  it('is not-checked, naming it, when the baseUrl is not a URL at all', async () => {
    // Not unreachable either: a typo'd baseUrl was never asked about, and the
    // remedy is to fix the config rather than to start anything.
    const backend = answering(200);
    const result = await probeBackend('127.0.0.1:7421', { fetch: backend.fetch, now });

    assert.equal(result.state, 'not-checked');
    assert.match(result.reason ?? '', /`baseUrl` is not a URL: 127\.0\.0\.1:7421/);
    assert.deepEqual(backend.calls, []);
  });

  it('reports the unresolved secret, not the parse failure, when a baseUrl is both', async () => {
    // Ordering, and it is load-bearing. The parse-failure reason echoes
    // `baseUrl` verbatim — correct for a typo, a leak for a marker. Measured: a
    // marker in the host position does not parse (NUL is a forbidden host code
    // point), so checking the secret second would put the marker in output.
    const result = await probeBackend(UNRESOLVED_HOST_URL, { fetch: answering(200).fetch, now });

    assert.equal(result.state, 'not-checked');
    assert.match(result.reason ?? '', /secret that has not resolved/);
    assert.doesNotMatch(result.reason ?? '', /is not a URL/);
    assert.doesNotMatch(result.reason ?? '', /tuplescope:/);
  });
});

describe('the database, given the shape of the backend', () => {
  it('counts one table without pluralising it', () => {
    const result = databaseReachable({ tables: 1, schema: 'public' }, { now });

    assert.equal(result.state, 'reachable');
    assert.equal(result.reason, '1 table in `public`');
  });

  it('pluralises zero, because zero tables is plural and also worth reading', () => {
    // An empty schema is reachable and almost certainly not what someone meant
    // — "0 tables" is how they find out they are pointed at the wrong database.
    const result = databaseReachable({ tables: 0, schema: 'public' }, { now });

    assert.equal(result.state, 'reachable');
    assert.equal(result.reason, '0 tables in `public`');
  });

  it('pluralises the ordinary case', () => {
    assert.equal(databaseReachable({ tables: 35, schema: 'public' }, { now }).reason, '35 tables in `public`');
  });

  it('quotes the schema, so a schema named like a word stays legible', () => {
    // Unquoted, "1 table in public" reads as prose and hides which schema was
    // counted; it matters most when the schema is not the default.
    assert.equal(databaseReachable({ tables: 12, schema: 'billing' }, { now }).reason, '12 tables in `billing`');
  });

  it('carries a reason and a remedy when it could not be reached', () => {
    const result = databaseUnreachable(
      { reason: 'the database at 127.0.0.1:5432 refused the connection', remedy: 'Start Postgres, then check again.' },
      { now },
    );

    assert.equal(result.state, 'unreachable');
    assert.equal(result.reason, 'the database at 127.0.0.1:5432 refused the connection');
    assert.equal(result.remedy, 'Start Postgres, then check again.');
  });

  it('omits remedy entirely rather than carrying an empty one', () => {
    // Absent, not `undefined`: this is serialised to the page, and a `remedy`
    // key present-but-empty renders as a blank line where advice should be.
    const result = databaseUnreachable({ reason: 'no connection string is configured' }, { now });

    assert.ok(!('remedy' in result));
  });
});

describe('when the answer was taken', () => {
  /**
   * The single invariant this module exists for, checked across every
   * constructor at once so a fourth one cannot be added without landing here.
   *
   * A reader renders these next to a coloured dot. Without `checkedAt` the dot
   * is a claim about now backed by evidence of unknown age, which is the exact
   * stale green TupleScope is for.
   */
  it('stamps every result, in every state, from the injected clock', async () => {
    const results = [
      ['reachable backend', await probeBackend('http://127.0.0.1:7421', { fetch: answering(200).fetch, now })],
      [
        'unreachable backend',
        await probeBackend('http://127.0.0.1:7421', { fetch: failing(connectionRefused()).fetch, now }),
      ],
      [
        'not-checked, unresolved secret',
        await probeBackend(UNRESOLVED_PASSWORD_URL, { fetch: answering(200).fetch, now }),
      ],
      ['not-checked, bad url', await probeBackend('127.0.0.1:7421', { fetch: answering(200).fetch, now })],
      ['reachable database', databaseReachable({ tables: 35, schema: 'public' }, { now })],
      ['unreachable database', databaseUnreachable({ reason: 'refused' }, { now })],
    ] as const;

    for (const [label, result] of results) {
      assert.equal(result.checkedAt, AT, `${label} was not stamped from the injected clock`);
    }
  });

  it('stamps the probe even when the fetch throws, from before the attempt', async () => {
    // The failing case is the one that most needs a time on it: it is the one
    // someone stares at while restarting things, and a stamp that never moves
    // is how they know the page is not refetching.
    const result = await probeBackend('http://127.0.0.1:7421', { fetch: failing(timedOut()).fetch, now });

    assert.equal(result.state, 'unreachable');
    assert.equal(result.checkedAt, AT);
  });
});

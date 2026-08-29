/**
 * The difference between "that thing is gone" and "your server is old".
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { apiError } = require('../public/api-error.js');

describe('a 404 from a route the server does not have', () => {
  it('says the runtime is behind the page, and how to fix it', () => {
    // What the page used to show: `Route POST:/api/run-jobs not found`.
    const error = apiError({
      status: 404,
      body: { message: 'Route POST:/api/run-jobs not found', error: 'Not Found', statusCode: 404 },
      path: '/api/run-jobs',
    });
    assert.equal(error.error, 'RUNTIME_TOO_OLD');
    assert.match(error.message, /newer than the runtime/);
    assert.match(error.message, /pnpm start/);
    assert.match(error.message, /\/api\/run-jobs/);
  });

  it('names the route without its query string', () => {
    const error = apiError({ status: 404, body: { error: 'Not Found' }, path: '/api/run-jobs/abc?x=1' });
    assert.equal(error.route, '/api/run-jobs/abc');
  });
});

describe("a 404 the application itself raised", () => {
  it('keeps its own words — it is about a missing thing, not a stale server', () => {
    const error = apiError({
      status: 404,
      body: { error: 'NO_SUCH_RUN_JOB', message: 'No run job `job_x` is still available.' },
      path: '/api/run-jobs/job_x',
    });
    assert.equal(error.error, 'NO_SUCH_RUN_JOB');
    assert.equal(error.message, 'No run job `job_x` is still available.');
  });
});

describe('everything else', () => {
  it('carries the server’s message and code through', () => {
    const error = apiError({
      status: 409,
      body: { error: 'NOT_ENABLED', message: '`adminer` is not enabled for /x.' },
      path: '/api/handoff/open',
    });
    assert.equal(error.error, 'NOT_ENABLED');
    assert.match(error.message, /not enabled/);
  });

  it('falls back to the status when there is no body at all', () => {
    // `api()` swallows a JSON parse failure into `{}`, so this is reachable.
    assert.match(apiError({ status: 502, body: {}, path: '/api/runs' }).message, /502/);
  });
});

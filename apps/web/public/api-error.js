/**
 * Turning a failed response into something the person reading it can act on.
 *
 * One case matters enough to have its own file. Static files are read from disk
 * on every request, so the page updates the moment you rebuild — while a
 * long-lived runtime keeps serving the routes it started with. A runtime that
 * had been up 27 hours answered `POST /api/run-jobs` with Fastify's own
 * `Route POST:/api/run-jobs not found`, which the page showed verbatim. Run
 * did nothing, twice over: no run, and no sentence anyone could use.
 *
 * The tell is that Fastify's routing 404 carries `error: "Not Found"`, whereas
 * every 404 this application raises carries a code of its own — `NO_SUCH_RUN_JOB`,
 * `NO_SUCH_CHANGE`. Those are about a thing that is missing and must keep their
 * own words; this one is about a server that is out of date.
 */
function apiError({ status, body, path }) {
  const route = String(path).split('?')[0];
  if (status === 404 && body && body.error === 'Not Found') {
    return Object.assign(
      new Error(
        `This page is newer than the runtime serving it — that runtime has no \`${route}\`. ` +
          'Restart it (`pnpm start`) and reload.',
      ),
      { error: 'RUNTIME_TOO_OLD', statusCode: 404, route },
    );
  }
  return Object.assign(new Error((body && body.message) || `HTTP ${status}`), body || {});
}

if (typeof module !== 'undefined') module.exports = { apiError };

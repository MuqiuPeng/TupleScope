/**
 * Putting the database back to its baseline, and stopping there.
 *
 * Its own module so it can be tested over a real Fastify with the same headers
 * the page sends — which is how the one bug this route has had was found, and
 * not by the `curl` that "tested" it.
 */

import type { FastifyInstance } from 'fastify';

export interface ResetRouteOptions {
  /** Absent when the workspace declares no `resetUrl`: there is nothing to call. */
  reset?: () => Promise<void>;
  /** Whether a run is in flight right now. */
  isRunning: () => boolean;
}

export function registerResetRoute(app: FastifyInstance, options: ResetRouteOptions): void {
  app.post('/api/reset', async (_request, reply) => {
    if (!options.reset) {
      return reply.status(409).send({
        error: 'NO_RESET',
        message: 'This workspace declares no `resetUrl`, so there is no baseline to return to.',
      });
    }
    if (options.isRunning()) {
      // Resetting under a capture window pulls the state out from under it, and
      // every change it went on to report would be a lie.
      return reply.status(409).send({
        error: 'RUN_IN_PROGRESS',
        message: 'A run is in progress. Resetting now would corrupt what it reports.',
      });
    }
    try {
      await options.reset();
      return { ok: true, at: new Date().toISOString() };
    } catch (error) {
      // Reported, never swallowed. A reset that silently did nothing leaves the
      // next run's evidence describing a database nobody put in a known state.
      return reply.status(502).send({
        error: 'RESET_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

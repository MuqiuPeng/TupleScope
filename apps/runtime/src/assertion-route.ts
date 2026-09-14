/**
 * Keeping an expression as an assertion in its scenario file.
 *
 * Its own module for the same reason as the reset route: so it can be tested
 * over a real Fastify. The defect it had was a message naming the wrong thing.
 * A scenario id that matched no loaded file fell into the missing-field branch,
 * so a request carrying all four fields was told that all four were required —
 * while an unknown dataset or step got a precise 422 naming it. Found by a
 * verification pass that sent exactly that request.
 */

import type { FastifyInstance } from 'fastify';
import { addAssertion, ScenarioSaveError } from '@tuplescope/scenario-engine';

export interface AssertionRouteOptions {
  /**
   * Scenario id → the file it was loaded from. A getter, because the server
   * replaces the map whenever it re-reads the scenarios directory.
   */
  files: () => ReadonlyMap<string, string>;
  /** Re-reads the directory after a write, so the next listing has the new line. */
  reload: () => Promise<void>;
}

const FIELDS = ['scenarioId', 'datasetId', 'stepId', 'expression'] as const;
type Body = Partial<Record<(typeof FIELDS)[number], unknown>>;

export function registerAssertionRoute(app: FastifyInstance, options: AssertionRouteOptions): void {
  app.post<{ Body: Body }>('/api/assertions', async (request, reply) => {
    const body = request.body ?? {};
    const missing = FIELDS.filter((field) => typeof body[field] !== 'string' || body[field] === '');
    if (missing.length > 0) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message:
          `Missing ${missing.map((field) => `\`${field}\``).join(', ')}. ` +
          'scenarioId, datasetId, stepId and expression are all required.',
      });
    }
    const { scenarioId, datasetId, stepId, expression } = body as Record<(typeof FIELDS)[number], string>;

    const files = options.files();
    const file = files.get(scenarioId);
    if (!file) {
      // The same status and code as an unknown dataset or step — those come
      // back from `addAssertion` as a ScenarioSaveError naming what is missing —
      // so the page handles all three the same way.
      const loaded = [...files.keys()].sort();
      return reply.status(422).send({
        error: 'CANNOT_SAVE',
        message:
          `No scenario \`${scenarioId}\` is loaded in this workspace. ` +
          (loaded.length > 0 ? `Loaded: ${loaded.join(', ')}.` : 'None are loaded.'),
      });
    }

    try {
      const result = await addAssertion({ file, datasetId, stepId, expression });
      await options.reload();
      return result;
    } catch (error) {
      if (error instanceof ScenarioSaveError) {
        return reply.status(422).send({ error: 'CANNOT_SAVE', message: error.message });
      }
      throw error;
    }
  });
}

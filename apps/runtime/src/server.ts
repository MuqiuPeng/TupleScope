/**
 * The StateScope local runtime.
 *
 * A thin HTTP shell over the engine. Everything it exposes, the CLI and MCP
 * will need too, so no logic lives here that they would have to reimplement —
 * this file resolves config, wires the adapter and the runner together, and
 * serves the UI.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import YAML from 'yaml';
import { MvccPostgresAdapter } from '@statescope/db-postgres';
import { HttpRunner } from '@statescope/http-runner';
import {
  ScenarioEngine,
  addAssertion,
  removeAssertion,
  ScenarioSaveError,
} from '@statescope/scenario-engine';
import type { CaptureScope, Run, Scenario } from '@statescope/core';
import { createGuard, mintToken } from './security.js';

interface WorkspaceConfig {
  name: string;
  baseUrl: string;
  database: { connectionString: string };
  scenariosDir: string;
  identities?: Array<{ id: string; header: { name: string; value: string } }>;
  ignoreColumns?: string[];
  maskColumns?: string[];
  /** Endpoint that wipes and reseeds, used by datasets declaring `resetFirst`. */
  resetUrl?: string;
  /** Idle window watched before each run to detect writers other than the scenario. */
  baselineWindowMs?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['STATESCOPE_PORT'] ?? 7420);
const CONFIG_PATH = resolve(
  process.env['STATESCOPE_CONFIG'] ?? resolve(here, '../../../statescope.yaml'),
);

async function loadConfig(): Promise<{ config: WorkspaceConfig; dir: string }> {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const config = YAML.parse(raw) as WorkspaceConfig;
  const dir = dirname(CONFIG_PATH);
  if (!isAbsolute(config.scenariosDir)) {
    config.scenariosDir = resolve(dir, config.scenariosDir);
  }
  return { config, dir };
}

async function main(): Promise<void> {
  const { config } = await loadConfig();
  const token = process.env['STATESCOPE_TOKEN'] ?? mintToken();

  const adapter = new MvccPostgresAdapter({
    connectionString: config.database.connectionString,
    ...(config.maskColumns ? { maskColumns: config.maskColumns } : {}),
  });
  const runner = new HttpRunner({
    baseUrl: config.baseUrl,
    ...(config.identities ? { identities: config.identities } : {}),
  });
  const engine = new ScenarioEngine({
    adapter,
    runner,
    baselineWindowMs: config.baselineWindowMs ?? 0,
    ...(config.resetUrl
      ? {
          reset: async () => {
            const response = await fetch(config.resetUrl!, { method: 'POST' });
            if (!response.ok) {
              throw new Error(`Reset endpoint answered ${response.status}. Is the backend running?`);
            }
          },
        }
      : {}),
  });

  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'warn' } });
  app.addHook('onRequest', createGuard({ token, port: PORT, publicPaths: new Set(['/health']) }));

  await app.register(fastifyStatic, { root: resolve(here, '../../web/public'), prefix: '/' });

  /** Cached so the UI can list scenarios without re-reading the disk each poll. */
  let scenarios: Scenario[] = [];
  /** Which file each scenario came from, so an edit can be written back to it. */
  let files = new Map<string, string>();
  const reloadScenarios = async (): Promise<void> => {
    const loaded = await loadScenariosWithPaths(config.scenariosDir);
    scenarios = loaded.map((l) => l.scenario);
    files = new Map(loaded.map((l) => [l.scenario.id, l.file]));
  };
  await reloadScenarios();

  const runs: Run[] = [];
  /**
   * Variables from the last full run of each dataset. "Run from here" needs
   * them: step 3 references what step 1 captured, and a partial run never ran
   * step 1.
   */
  const lastVariables = new Map<string, Readonly<Record<string, string>>>();

  app.get('/health', async () => ({ ok: true, service: 'statescope' }));

  app.get('/api/workspace', async () => ({
    name: config.name,
    baseUrl: config.baseUrl,
    identities: config.identities?.map((i) => i.id) ?? [],
    tables: await adapter.listTables(),
    captureMethod: adapter.captureMethod,
    detection: adapter.detection,
  }));

  app.get('/api/scenarios', async () => {
    await reloadScenarios();
    return scenarios;
  });

  app.get('/api/runs', async () => runs.slice(-20).reverse());

  app.post<{
    Body: { scenarioId?: string; datasetId?: string; fromStepId?: string; onlyStepId?: string };
  }>('/api/runs', async (request, reply) => {
    const { scenarioId, datasetId, fromStepId, onlyStepId } = request.body ?? {};

    // Re-read before every run. Editing the YAML and pressing Run must execute
    // what is on disk — running a stale copy would make "what did this run
    // actually do?" unanswerable, which is the one question this tool exists
    // to answer.
    try {
      await reloadScenarios();
    } catch (error) {
      return reply.status(422).send({
        error: 'SCENARIO_WILL_NOT_LOAD',
        message: error instanceof Error ? error.message : String(error),
        remedy: 'Fix the scenario file and run again.',
      });
    }

    const scenario = scenarios.find((s) => s.id === scenarioId);
    if (!scenario) {
      return reply.status(404).send({
        error: 'NO_SUCH_SCENARIO',
        message: `No scenario \`${scenarioId}\`. Loaded: ${scenarios.map((s) => s.id).join(', ') || '(none)'}.`,
      });
    }
    const dataset = datasetId ?? scenario.datasets[0]!.id;

    let scope: CaptureScope;
    try {
      scope = await buildScope(adapter, scenario, config);
    } catch (error) {
      return reply.status(503).send({
        error: 'DATABASE_UNREACHABLE',
        message: error instanceof Error ? error.message : String(error),
        remedy: 'Start the database for this workspace, then run again.',
      });
    }

    const key = `${scenario.id}/${dataset}`;
    const carried = fromStepId || onlyStepId ? lastVariables.get(key) : undefined;

    let run: Run;
    try {
      run = await engine.run(scenario, dataset, scope, {
        ...(fromStepId ? { fromStepId } : {}),
        ...(onlyStepId ? { onlyStepId } : {}),
        ...(carried ? { variables: carried } : {}),
      });
    } catch (error) {
      return reply.status(400).send({
        error: 'BAD_RUN_REQUEST',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // Only a full run's variables are worth carrying: a partial run's are a
    // mixture of carried and fresh, and reusing them compounds the confusion.
    if (run.coverage === 'full') lastVariables.set(key, run.variables);
    runs.push(run);
    return run;
  });

  /**
   * Keeps an observed change as an assertion — the observe-then-promote loop.
   * Writes into the scenario's own file, preserving its comments.
   */
  app.post<{
    Body: { scenarioId?: string; datasetId?: string; stepId?: string; expression?: string };
  }>('/api/assertions', async (request, reply) => {
    const { scenarioId, datasetId, stepId, expression } = request.body ?? {};
    const file = scenarioId ? files.get(scenarioId) : undefined;
    if (!file || !datasetId || !stepId || !expression) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: 'scenarioId, datasetId, stepId and expression are all required.',
      });
    }
    try {
      const result = await addAssertion({ file, datasetId, stepId, expression });
      await reloadScenarios();
      return result;
    } catch (error) {
      if (error instanceof ScenarioSaveError) {
        return reply.status(422).send({ error: 'CANNOT_SAVE', message: error.message });
      }
      throw error;
    }
  });

  app.delete<{
    Body: { scenarioId?: string; datasetId?: string; stepId?: string; expression?: string };
  }>('/api/assertions', async (request, reply) => {
    const { scenarioId, datasetId, stepId, expression } = request.body ?? {};
    const file = scenarioId ? files.get(scenarioId) : undefined;
    if (!file || !datasetId || !stepId || !expression) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: 'All fields are required.' });
    }
    const result = await removeAssertion({ file, datasetId, stepId, expression });
    await reloadScenarios();
    return result;
  });

  await app.listen({ port: PORT, host: '127.0.0.1' });

  const url = `http://127.0.0.1:${PORT}/?token=${token}`;
  console.log(`
  StateScope runtime
  ------------------
  UI        ${url}
  Workspace ${config.name}  ->  ${config.baseUrl}
  Capture   ${adapter.captureMethod} (${adapter.detection} detection)
  Scenarios ${scenarios.length} loaded from ${config.scenariosDir}
`);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await adapter.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/**
 * Loads scenarios while remembering which file each came from, so a promoted
 * assertion can be written back to the right one.
 */
async function loadScenariosWithPaths(
  dir: string,
): Promise<Array<{ scenario: Scenario; file: string }>> {
  const { readdir } = await import('node:fs/promises');
  const { loadScenario } = await import('@statescope/scenario-engine');
  const names = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  const out: Array<{ scenario: Scenario; file: string }> = [];
  for (const name of names) {
    const file = resolve(dir, name);
    out.push({ scenario: await loadScenario(file), file });
  }
  return out;
}

/**
 * Turns a scenario's optional `watch` into a capture scope.
 *
 * Omitting `watch` observes everything, which is the better default: a
 * hand-picked list quietly hides whatever it forgot, and demanding one before
 * the first run is the main thing standing between a new user and their first
 * diff.
 */
async function buildScope(
  adapter: MvccPostgresAdapter,
  scenario: Scenario,
  config: WorkspaceConfig,
): Promise<CaptureScope> {
  const ignoreColumns = [...(config.ignoreColumns ?? []), ...(scenario.ignoreColumns ?? [])];
  const maskedColumns = [...(config.maskColumns ?? []), ...(scenario.maskColumns ?? [])];

  if (!scenario.watch || scenario.watch.length === 0) {
    return adapter.fullScope({ ignoreColumns, maskedColumns });
  }
  const full = await adapter.fullScope({ ignoreColumns, maskedColumns });
  const byName = new Map(full.tables.map((t) => [t.table, t]));
  return {
    allTables: false,
    tables: scenario.watch.map((spec) => {
      const base = byName.get(spec.table);
      if (!base) {
        throw new Error(
          `Scenario \`${scenario.id}\` watches \`${spec.table}\`, which is not a table in this database.`,
        );
      }
      return {
        ...base,
        ...(spec.where !== undefined ? { where: spec.where } : {}),
        ignoreColumns: [...ignoreColumns, ...(spec.ignoreColumns ?? [])],
      };
    }),
  };
}

void main().catch((error: unknown) => {
  console.error('[statescope] failed to start:', error);
  process.exit(1);
});

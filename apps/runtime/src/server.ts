/**
 * The TupleScope local runtime.
 *
 * A thin HTTP shell over the engine. Everything it exposes, the CLI and MCP
 * will need too, so no logic lives here that they would have to reimplement —
 * this file resolves config, wires the adapter and the runner together, and
 * serves the UI.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { withHandoffs } from './handoff-payload.js';
import { registerHandoffRoutes } from './handoff-routes.js';
import { registerResetRoute } from './reset-route.js';
import { openUrl } from './open-url.js';
import { addAssertion, removeAssertion, ScenarioSaveError } from '@tuplescope/scenario-engine';
import {
  loadWorkspaceConfig,
  openWorkspace,
  } from '@tuplescope/workspace';
import type { CaptureScope, Run, Scenario } from '@tuplescope/core';
import { createGuard, mintToken } from './security.js';
import { removeSession, writeSession } from './session.js';
import { withRequestOverrides } from './request-overrides.js';
import type { RequestOverride } from './request-overrides.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['TUPLESCOPE_PORT'] ?? 7420);

async function main(): Promise<void> {
  const config = await loadWorkspaceConfig();
  const token = process.env['TUPLESCOPE_TOKEN'] ?? mintToken();

  const workspace = openWorkspace(config);
  const { adapter, engine } = workspace;

  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'warn' } });
  app.addHook('onRequest', createGuard({ token, port: PORT, publicPaths: new Set(['/health']) }));

  await app.register(fastifyStatic, { root: resolve(here, '../../web/public'), prefix: '/' });

  /** Cached so the UI can list scenarios without re-reading the disk each poll. */
  let scenarios: Scenario[] = [];
  /** Which file each scenario came from, so an edit can be written back to it. */
  let files = new Map<string, string>();
  const reloadScenarios = async (): Promise<void> => {
    const loaded = await workspace.scenarios();
    scenarios = loaded.map((l) => l.scenario);
    files = new Map(loaded.map((l) => [l.scenario.id, l.file]));
  };
  await reloadScenarios();

  const runs: Run[] = [];
  type RunRequest = {
    scenarioId?: string;
    datasetId?: string;
    fromStepId?: string;
    onlyStepId?: string;
    requestOverrides?: Readonly<Record<string, RequestOverride>>;
  };
  type RunJob = {
    id: string;
    status: 'running' | 'finished' | 'errored';
    createdAt: string;
    run?: Run;
    error?: { error: string; message: string; remedy?: string };
  };
  const runJobs = new Map<string, RunJob>();
  /**
   * Variables from the last full run of each dataset. "Run from here" needs
   * them: step 3 references what step 1 captured, and a partial run never ran
   * step 1.
   */
  const lastVariables = new Map<string, Readonly<Record<string, string>>>();

  app.get('/health', async () => ({ ok: true, service: 'tuplescope' }));

  app.get('/api/workspace', async () => ({
    name: config.name,
    baseUrl: config.baseUrl,
    identities: config.identities?.map((i) => i.id) ?? [],
    tables: await adapter.listTables(),
    captureMethod: adapter.captureMethod,
    detection: adapter.detection,
    fidelity: adapter.fidelity,
    resetConfigured: Boolean(config.resetUrl),
  }));

  app.get('/api/scenarios', async () => {
    await reloadScenarios();
    return scenarios;
  });

  app.get('/api/runs', async () => runs.slice(-20).reverse().map(withHandoffs));

  // Separate from running because they are separate intentions. A run resets so
  // that its evidence means something; a person resets so they can go and look
  // at a clean database — a great deal more useful now that a row can be opened
  // in one. Bundled, the only way to reach a known state was to immediately
  // destroy it with five requests.
  registerHandoffRoutes(app, {
    // `configDir` and not `process.cwd()`: the grant is for the workspace this
    // server is serving, and a runtime started from somewhere else is still
    // serving that one.
    workspaceRoot: workspace.config.configDir,
    connectionString: workspace.config.database.connectionString,
    findRun: (runId) =>
      runs.find((run) => run.id === runId) ??
      [...runJobs.values()].map((job) => job.run).find((run) => run?.id === runId),
    openUrl,
  });

  registerResetRoute(app, {
    ...(workspace.reset ? { reset: workspace.reset.bind(workspace) } : {}),
    isRunning: () => [...runJobs.values()].some((job) => job.status === 'running'),
  });

  app.post<{ Body: RunRequest }>('/api/run-jobs', async (request, reply) => {
    const active = [...runJobs.values()].find((job) => job.status === 'running');
    if (active) {
      return reply.status(409).send({
        error: 'RUN_IN_PROGRESS',
        message: 'A dataset is already running in this workspace.',
        jobId: active.id,
      });
    }

    const id = `job_${Date.now().toString(36)}`;
    const job: RunJob = { id, status: 'running', createdAt: new Date().toISOString() };
    runJobs.set(id, job);
    // A UI session needs only its recent jobs. Bound the in-memory list rather
    // than turning a long-lived runtime into an accidental history store.
    while (runJobs.size > 30) runJobs.delete(runJobs.keys().next().value!);

    void runInJob(job, request.body ?? {});
    return reply.status(202).send({ jobId: id });
  });

  app.get<{ Params: { id: string } }>('/api/run-jobs/:id', async (request, reply) => {
    const job = runJobs.get(request.params.id);
    if (!job) {
      return reply.status(404).send({
        error: 'NO_SUCH_RUN_JOB',
        message: `No run job \`${request.params.id}\` is still available.`,
      });
    }
    return { ...job, ...(job.run ? { run: withHandoffs(job.run) } : {}) };
  });

  async function runInJob(job: RunJob, body: RunRequest): Promise<void> {
    const { scenarioId, datasetId, fromStepId, onlyStepId, requestOverrides } = body;
    try {
      await reloadScenarios();
      const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
      if (!scenario) {
        throw Object.assign(new Error(
          `No scenario \`${scenarioId}\`. Loaded: ${scenarios.map((s) => s.id).join(', ') || '(none)'}.`,
        ), { code: 'NO_SUCH_SCENARIO' });
      }
      const dataset = datasetId ?? scenario.datasets[0]!.id;
      const executable = withRequestOverrides(
        scenario,
        dataset,
        requestOverrides,
        config.identities?.map((identity) => identity.id) ?? [],
      );
      const scope = await workspace.scopeFor(executable);
      const key = `${scenario.id}/${dataset}`;
      const carried = fromStepId || onlyStepId ? lastVariables.get(key) : undefined;

      const run = await engine.run(executable, dataset, scope, {
        ...(fromStepId ? { fromStepId } : {}),
        ...(onlyStepId ? { onlyStepId } : {}),
        ...(carried ? { variables: carried } : {}),
        onProgress: ({ run: progress }) => {
          // The engine mutates one Run object as it advances. A clone freezes
          // this particular moment so a poll cannot observe it half-mutated.
          job.run = structuredClone(progress);
        },
      });
      job.run = structuredClone(run);
      job.status = 'finished';
      if (run.coverage === 'full') lastVariables.set(key, run.variables);
      runs.push(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = 'errored';
      job.error = {
        error: (error as { code?: string }).code ?? 'RUN_COULD_NOT_START',
        message,
        ...(/ECONNREFUSED|ENOTFOUND|password authentication|does not exist/i.test(message)
          ? { remedy: 'Start the database and backend for this workspace, then run again.' }
          : {}),
      };
    }
  }

  app.post<{
    Body: RunRequest;
  }>('/api/runs', async (request, reply) => {
    const { scenarioId, datasetId, fromStepId, onlyStepId, requestOverrides } = request.body ?? {};

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

    let executable: Scenario;
    try {
      executable = withRequestOverrides(
        scenario,
        dataset,
        requestOverrides,
        config.identities?.map((identity) => identity.id) ?? [],
      );
    } catch (error) {
      return reply.status(400).send({
        error: 'BAD_REQUEST_OVERRIDE',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    let scope: CaptureScope;
    try {
      scope = await workspace.scopeFor(executable);
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
      run = await engine.run(executable, dataset, scope, {
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
    return withHandoffs(run);
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
  // So the URL is recoverable after the terminal that printed it is gone.
  const sessionFile = writeSession({
    pid: process.pid,
    port: PORT,
    token,
    url,
    workspace: config.name,
    startedAt: new Date().toISOString(),
  });

  console.log(`
  TupleScope runtime
  ------------------
  UI        ${url}
  Workspace ${config.name}  ->  ${config.baseUrl}
  Capture   ${adapter.captureMethod} (${adapter.detection} detection)
  Scenarios ${scenarios.length} loaded from ${config.scenariosDir}
${sessionFile ? `  Lost it?  tuplescope url  (reads ${sessionFile})` : ''}
`);

  const shutdown = async (): Promise<void> => {
    removeSession(PORT);
    await app.close();
    await workspace.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error('[tuplescope] failed to start:', error);
  process.exit(1);
});

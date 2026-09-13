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
import { panelsFor } from './panels.js';
import { registerHandoffRoutes } from './handoff-routes.js';
import { registerResetRoute } from './reset-route.js';
import { openUrl } from './open-url.js';
import { registerAssertionRoute } from './assertion-route.js';
import {
  registerHealthRoute,
  runRefusal,
  startTheDatabase,
  workspaceReachability,
} from './health-route.js';
import { createRunAdmission } from './run-admission.js';
import { loadWorkspace, openWorkspace } from '@tuplescope/workspace';
import type { Run, Scenario } from '@tuplescope/core';
import { outcomeOfStep, verdictOf } from '@tuplescope/core';
import { createGuard, mintToken, SECURITY_HEADERS } from './security.js';
import { removeSession, writeSession } from './session.js';
import { withRequestOverrides } from './request-overrides.js';
import type { RequestOverride } from './request-overrides.js';
import { scrubbingLogStream, scrubErrorBodies, scrubStepErrors } from './scrub.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['TUPLESCOPE_PORT'] ?? 7420);

/**
 * Removes resolved credentials from text this process did not format.
 *
 * A PostgreSQL driver reports an authentication failure with the connection
 * string inline, and that message is what a route sends back to the page. Set
 * once the workspace has resolved its secrets; identity until then.
 */
let scrub: (text: string) => string = (text) => text;

/** The message of anything thrown, without asserting it was an Error. */
function message(error: unknown): string {
  return scrub(error instanceof Error ? error.message : String(error));
}

async function main(): Promise<void> {
  // Load and resolve, through the one door. The runtime used to load the file
  // and open it — and a workspace with its password in the keychain, which is
  // what the README tells people to do, could not start.
  const resolved = await loadWorkspace();
  scrub = resolved.scrub;
  const config = resolved.config;
  const token = process.env['TUPLESCOPE_TOKEN'] ?? mintToken();

  const workspace = openWorkspace(config);
  const { adapter, engine } = workspace;

  // Both through the workspace's scrub: every log line on its way to stdout, and
  // every error body on its way out. See `scrub.ts` for the leak that measured.
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'warn',
      stream: scrubbingLogStream(resolved.scrub),
    },
  });
  scrubErrorBodies(app, resolved.scrub);
  app.addHook('onRequest', createGuard({ token, port: PORT, publicPaths: new Set(['/health']) }));
  // On every response, including the guard's own refusals and the 404s — a
  // policy that covers only the happy path is a policy with holes in the shapes
  // an attacker reaches for.
  app.addHook('onSend', async (_request, reply) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) reply.header(header, value);
  });

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

  app.get('/api/workspace', async () => {
    // A database that is down is no longer fatal. This used to answer 503, which
    // turned the whole page into an error screen — while the scenario list, the
    // stored runs and the indicator that would have *explained* the 503 all need
    // no database at all. It is now one of two reported states, and the page
    // stays usable around it.
    //
    // `baseUrl` is probed rather than echoed. Echoing it let the page draw a
    // backend nobody had asked about.
    const { tables, database, backend } = await workspaceReachability({
      adapter,
      baseUrl: config.baseUrl,
      scrub: resolved.scrub,
    });
    return {
      // Scrubbed for the same reason `database` and `backend` are, and it was
      // missed because it looks inert. This route reads a *resolved* workspace,
      // so a `baseUrl` written `https://app:${secret:api_pw}@api.example.com`
      // holds the real credential by the time it gets here — and it travels
      // inside a 200, which `scrubErrorBodies` never sees. `name` too: a
      // `${secret:…}` in it is accepted by the config loader.
      name: resolved.scrub(config.name),
      baseUrl: resolved.scrub(config.baseUrl),
      identities: config.identities?.map((i) => i.id) ?? [],
      tables,
      captureMethod: adapter.captureMethod,
      detection: adapter.detection,
      fidelity: adapter.fidelity,
      resetConfigured: Boolean(config.resetUrl),
      database,
      backend,
    };
  });

  // The same two values, cheaply enough to ask on every window focus: no table
  // listing, and no second copy of the rule that turns an outcome into a state.
  registerHealthRoute(app, {
    pingDatabase: () => adapter.ping(),
    baseUrl: config.baseUrl,
    scrub: resolved.scrub,
  });

  app.get('/api/scenarios', async () => {
    await reloadScenarios();
    return scenarios;
  });

  // Panels ride with the run rather than being a route of their own: they are a
  // view of *this* run's observations, and fetching them separately would let
  // the page draw one run's chart beside another run's diff.
  const decorate = (run: Run): unknown => {
    const decorated = withHandoffs(run) as { steps: Array<Record<string, unknown>> };
    return {
      ...decorated,
      // The verdict, computed once, by the same function the CLI and the exit
      // code use. The page used to derive its own, and the two disagreed: the
      // page's rule looked only at assertion statuses, so a run with every
      // assertion passing and a `scope-truncated` warning showed a green dot
      // while `tuplescope run` called it undecided and exited 3. A second
      // implementation of the verdict is the one thing this product cannot
      // afford to have.
      verdict: verdictOf(run),
      // Step errors travel inside a 200, past the error-body hook.
      steps: scrubStepErrors(decorated.steps, scrub).map((step, index) => ({
        ...step,
        outcome: outcomeOfStep(run.steps[index]!),
      })),
      panels: panelsFor(run, config.panels),
    };
  };

  app.get('/api/runs', async () => runs.slice(-20).reverse().map(decorate));

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

  // The admission rule lives in `run-admission.ts`, where it can be tested. It
  // owns the 409, the id, and the order in which the database is asked — see
  // that file for why the order is load-bearing.
  const admitRun = createRunAdmission<RunJob>({
    jobs: runJobs,
    create: (id) => ({ id, status: 'running', createdAt: new Date().toISOString() }),
    refuse: () => runRefusal({ pingDatabase: () => adapter.ping(), workspace: config.name }),
  });

  app.post<{ Body: RunRequest }>('/api/run-jobs', async (request, reply) => {
    const admission = await admitRun();
    if (!admission.admitted) return reply.status(admission.status).send(admission.body);
    void runInJob(admission.job, request.body ?? {});
    return reply.status(202).send({ jobId: admission.job.id });
  });

  app.get<{ Params: { id: string } }>('/api/run-jobs/:id', async (request, reply) => {
    const job = runJobs.get(request.params.id);
    if (!job) {
      return reply.status(404).send({
        error: 'NO_SUCH_RUN_JOB',
        message: `No run job \`${request.params.id}\` is still available.`,
      });
    }
    return { ...job, ...(job.run ? { run: decorate(job.run) } : {}) };
  });

  async function runInJob(job: RunJob, body: RunRequest): Promise<void> {
    const { scenarioId, datasetId, fromStepId, onlyStepId, requestOverrides } = body;
    try {
      // Each stage names its own failure. This was one flat try/catch reporting
      // `RUN_COULD_NOT_START` for everything and guessing a remedy from a regex
      // over the message — while a second, unreachable copy of this route
      // carried the taxonomy below. The page showed the worse of the two,
      // because the page calls the reachable one.
      try {
        await reloadScenarios();
      } catch (error) {
        throw Object.assign(new Error(message(error)), {
          code: 'SCENARIO_WILL_NOT_LOAD',
          remedy: 'Fix the scenario file and run again.',
        });
      }
      const scenario = scenarios.find((candidate) => candidate.id === scenarioId);
      if (!scenario) {
        throw Object.assign(new Error(
          `No scenario \`${scenarioId}\`. Loaded: ${scenarios.map((s) => s.id).join(', ') || '(none)'}.`,
        ), { code: 'NO_SUCH_SCENARIO' });
      }
      const dataset = datasetId ?? scenario.datasets[0]!.id;
      let executable;
      try {
        executable = withRequestOverrides(
          scenario,
          dataset,
          requestOverrides,
          config.identities?.map((identity) => identity.id) ?? [],
        );
      } catch (error) {
        throw Object.assign(new Error(message(error)), { code: 'BAD_REQUEST_OVERRIDE' });
      }
      let scope;
      try {
        scope = await workspace.scopeFor(executable);
      } catch (error) {
        throw Object.assign(new Error(message(error)), {
          code: 'DATABASE_UNREACHABLE',
          remedy: startTheDatabase('run'),
        });
      }
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
      const text = message(error);
      const tagged = error as { code?: string; remedy?: string };
      job.status = 'errored';
      job.error = {
        error: tagged.code ?? 'RUN_COULD_NOT_START',
        message: text,
        // A remedy the thrower knew, or — for anything reaching here untagged —
        // the guess that used to be the only answer.
        ...(tagged.remedy
          ? { remedy: tagged.remedy }
          : /ECONNREFUSED|ENOTFOUND|password authentication|does not exist/i.test(text)
            ? { remedy: 'Start the database and backend for this workspace, then run again.' }
            : {}),
      };
    }
  }

  registerAssertionRoute(app, { files: () => files, reload: reloadScenarios });


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

  // Scrubbed: `baseUrl` is resolved config, and one with credentials in it is
  // a URL people do write.
  console.log(scrub(`
  TupleScope runtime
  ------------------
  UI        ${url}
  Workspace ${config.name}  ->  ${config.baseUrl}
  Capture   ${adapter.captureMethod} (${adapter.detection} detection)
  Scenarios ${scenarios.length} loaded from ${config.scenariosDir}
${sessionFile ? `  Lost it?  tuplescope url  (reads ${sessionFile})` : ''}
`));

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
  // The stack, because a start failure is the one place a line number has
  // earned its keep — but scrubbed, because it can carry the connection string.
  console.error(
    '[tuplescope] failed to start:',
    scrub(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  );
  process.exit(1);
});

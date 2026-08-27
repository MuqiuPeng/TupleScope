#!/usr/bin/env node
/**
 * The MCP surface.
 *
 * A fourth caller of the same composition root the CLI and the runtime use, so
 * there is no logic here an agent could get a different answer from than a
 * person at a terminal would. Everything it returns is the envelope, the
 * verdict, or a thin projection of one of them.
 *
 * The one thing this file is careful about that the others need not be: an
 * agent reads a result field-by-field and reports the first thing that looks
 * like an answer. So every result leads with the verdict, `engineStatus` is
 * named as what it is rather than as `status`, and an undecided run says so in
 * prose before any number appears. A tool that lets an agent conclude "passed"
 * from a run that established nothing would undo the whole product.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DEFAULT_POLICY,
  exitCodeOf,
  mergeVerdicts,
  verdictOf,
  type RunVerdict,
  type VerdictPolicy,
} from '@statescope/core';
import { buildEnvelope } from '@statescope/report';
import { addAssertion, loadScenario } from '@statescope/scenario-engine';
import {
  loadWorkspaceConfig,
  openWorkspace,
  WorkspaceError,
  type WorkspaceSession,
} from '@statescope/workspace';
import { INSTRUCTIONS } from './instructions.js';

// ─── one session, opened lazily ───────────────────────────────────────────────

let session: WorkspaceSession | undefined;

async function workspace(): Promise<WorkspaceSession> {
  if (session) return session;
  const config = await loadWorkspaceConfig();
  session = openWorkspace(config, { history: { keep: 50 } });
  return session;
}

/** Every tool answers as text; an agent reads prose better than a JSON blob. */
type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });
const fail = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

async function guarded(body: () => Promise<Result>): Promise<Result> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return fail(`${error.message}${error.remedy ? `\n\n${error.remedy}` : ''}`);
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ─── how a verdict is spoken ──────────────────────────────────────────────────

/**
 * The verdict in prose, before any structured data.
 *
 * `undecided` gets the longest treatment on purpose: it is the outcome an agent
 * has no prior for, and the one where the intuitive reading — "nothing failed,
 * so it passed" — is exactly backwards.
 */
function describeVerdict(verdict: RunVerdict | ReturnType<typeof mergeVerdicts>): string {
  const exit = exitCodeOf(verdict.outcome);
  const head: Record<string, string> = {
    clean: `CLEAN (exit ${exit}) — every assertion evaluated and passed.`,
    failed: `FAILED (exit ${exit}) — the system under test is wrong. ${verdict.reason}`,
    errored: `ERRORED (exit ${exit}) — a step could not be executed. ${verdict.reason}`,
    undecided:
      `UNDECIDED (exit ${exit}) — this is NOT a pass and NOT a failure. The run completed and ` +
      `nothing contradicted it, but ${verdict.reason}. Do not report this as success, and do not ` +
      `tell the user their code is broken: tell them which check could not run, and why.`,
  };

  const lines = [head[verdict.outcome]!];
  lines.push(
    `assertions: ${verdict.assertions.passed} passed, ${verdict.assertions.failed} failed, ` +
      `${verdict.assertions.unevaluable} undecided, of ${verdict.assertions.total}.`,
  );
  if (verdict.proves === 'bounded') {
    lines.push(
      '',
      'This run does not establish everything it looks like it does. Carry these when you summarise it:',
      ...verdict.boundedBy.map((bound) => `  · ${bound}`),
    );
  }
  return lines.join('\n');
}

function describeRun(report: {
  selector: string;
  verdict: RunVerdict;
  run: { id: string; engineStatus: string };
  steps: ReadonlyArray<{
    id: string;
    outcome: string;
    engineStatus: string;
    response?: { status: number };
    assertions: ReadonlyArray<{ source: string; outcome: string; actual?: string; expected?: string; reason?: string }>;
    changes?: { tables: ReadonlyArray<{ table: string; inserted: number; updated: number; deleted: number; writtenNoVisibleChange: number }> };
  }>;
}): string {
  const lines: string[] = [`${report.selector}  (run ${report.run.id})`];
  for (const step of report.steps) {
    lines.push(
      `  [${step.outcome}] ${step.id}${step.response ? `  HTTP ${step.response.status}` : ''}`,
    );
    for (const table of step.changes?.tables ?? []) {
      const parts = [
        table.inserted ? `+${table.inserted}` : '',
        table.updated ? `${table.updated} updated` : '',
        table.deleted ? `-${table.deleted}` : '',
        // The differentiator. Never let it read as nothing having happened.
        table.writtenNoVisibleChange
          ? `${table.writtenNoVisibleChange} written with no visible change`
          : '',
      ].filter(Boolean);
      lines.push(`      ${table.table}: ${parts.join(', ')}`);
    }
    if (step.changes && step.changes.tables.length === 0) {
      lines.push('      nothing was written — not one row touched');
    }
    for (const assertion of step.assertions) {
      if (assertion.outcome === 'passed' || assertion.outcome === 'passed-as-refused') {
        lines.push(`      ok    ${assertion.source}`);
      } else if (assertion.outcome === 'failed') {
        lines.push(
          `      FAIL  ${assertion.source}  (expected ${assertion.expected ?? '—'}, got ${assertion.actual ?? '—'})`,
        );
      } else {
        lines.push(
          `      UNDECIDED  ${assertion.source}\n              this check did not run: ${assertion.reason ?? 'no reason recorded'}`,
        );
      }
    }
  }
  lines.push('', `engineStatus was "${report.run.engineStatus}" — that is whether the steps executed, not the verdict.`);
  return lines.join('\n');
}

// ─── the server ───────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: 'statescope', version: '0.3.0' },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  'describe_workspace',
  {
    description:
      'What this workspace points at: the API under test, the database, the capture engine, and the tables it can observe. Call this first — it is what tells you whether a scenario you write will resolve.',
    inputSchema: {},
  },
  async () =>
    guarded(async () => {
      const s = await workspace();
      const { tables } = await s.preflight();
      const scenarios = await s.scenarios();
      return ok(
        [
          `workspace   ${s.config.name}`,
          `api         ${s.config.baseUrl}`,
          `config      ${s.config.configFile}`,
          `scenarios   ${s.config.scenariosDir} (${scenarios.length} file(s))`,
          `capture     ${s.adapter.captureMethod}, ${s.adapter.detection} detection`,
          `identities  ${s.config.identities?.map((i) => i.id).join(', ') || '(none configured)'}`,
          `ignored     ${s.config.ignoreColumns?.join(', ') || '(none)'}`,
          `baseline    ${s.config.baselineWindowMs ? `${s.config.baselineWindowMs} ms idle probe` : 'not probed — concurrent writes would not be detected'}`,
          '',
          `tables (${tables.length}): ${tables.join(', ')}`,
        ].join('\n'),
      );
    }),
);

server.registerTool(
  'list_scenarios',
  {
    description: 'Every scenario and dataset in this workspace, with how many steps and assertions each has.',
    inputSchema: {},
  },
  async () =>
    guarded(async () => {
      const s = await workspace();
      const loaded = await s.scenarios();
      if (loaded.length === 0) return ok(`No scenarios in ${s.config.scenariosDir}.`);
      const lines = loaded.flatMap(({ scenario }) => [
        `${scenario.id}  ${scenario.title}`,
        ...scenario.datasets.map((dataset) => {
          const assertions = dataset.steps.reduce((n, step) => n + (step.assert?.length ?? 0), 0);
          const unchecked = dataset.steps.filter((step) => !step.assert?.length).length;
          return (
            `  ${scenario.id}/${dataset.id}  ${dataset.label}  ` +
            `— ${dataset.steps.length} steps, ${assertions} assertions` +
            (unchecked ? `, ${unchecked} step(s) checking nothing` : '')
          );
        }),
      ]);
      return ok(lines.join('\n'));
    }),
);

server.registerTool(
  'get_scenario',
  {
    description: 'One scenario in full: its steps, requests and assertions, exactly as written on disk.',
    inputSchema: { scenarioId: z.string().describe('The scenario id, as listed by list_scenarios.') },
  },
  async ({ scenarioId }) =>
    guarded(async () => {
      const s = await workspace();
      const found = (await s.scenarios()).find((entry) => entry.scenario.id === scenarioId);
      if (!found) {
        const known = (await s.scenarios()).map((e) => e.scenario.id);
        return fail(`No scenario \`${scenarioId}\`. There is: ${known.join(', ') || '(none)'}.`);
      }
      const { readFile } = await import('node:fs/promises');
      return ok(`${found.file}\n\n${await readFile(found.file, 'utf8')}`);
    }),
);

server.registerTool(
  'check_scenarios',
  {
    description:
      'What this suite can and cannot prove, WITHOUT sending a request. Resolves every assertion against the live schema, so a misspelled table — which otherwise passes silently, because an assertion about a table that does not exist finds nothing — is caught here. Call this after writing or editing a scenario.',
    inputSchema: {
      scenarioId: z.string().optional().describe('Limit to one scenario. Omit to check everything.'),
    },
  },
  async ({ scenarioId }) =>
    guarded(async () => {
      const s = await workspace();
      const { tables } = await s.preflight();
      const known = new Set(tables);
      const loaded = (await s.scenarios()).filter(
        (entry) => !scenarioId || entry.scenario.id === scenarioId,
      );
      const problems: string[] = [];
      let assertions = 0;

      for (const { scenario } of loaded) {
        for (const dataset of scenario.datasets) {
          for (const step of dataset.steps) {
            const list = step.assert ?? [];
            assertions += list.length;
            if (list.length === 0) {
              problems.push(
                `${scenario.id}/${dataset.id}/${step.id} checks nothing — it will be observed and verified by no one`,
              );
            }
            for (const assertion of list) {
              for (const table of tablesNamedIn(assertion)) {
                if (!known.has(table)) {
                  problems.push(
                    `${scenario.id}/${dataset.id}/${step.id} names table \`${table}\`, which is not in this database`,
                  );
                }
              }
            }
          }
        }
      }

      return ok(
        problems.length === 0
          ? `${loaded.length} scenario(s), ${assertions} assertions. Nothing here would fail for a reason other than the system under test.`
          : `${loaded.length} scenario(s), ${assertions} assertions.\n\nProblems:\n${problems
              .map((p) => `  · ${p}`)
              .join('\n')}\n\nThese would not fail loudly at run time; fix them before relying on the result.`,
      );
    }),
);

const SELECTORS = /\b(?:changes|inserted|updated|deleted|rows)\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const RESERVED = new Set(['response', 'true', 'false', 'null']);
const tablesNamedIn = (source: string): string[] =>
  [...source.matchAll(SELECTORS)].map((m) => m[1]!).filter((name) => !RESERVED.has(name));

server.registerTool(
  'run_scenario',
  {
    description:
      'Run one dataset and report what the API wrote. READ THE VERDICT, NOT engineStatus: a run whose assertions could not be evaluated has engineStatus "passed" and verdict "undecided", and reporting it as a success is the worst mistake available here.',
    inputSchema: {
      scenarioId: z.string(),
      datasetId: z.string().optional().describe('Omit to run every dataset of the scenario.'),
      unevaluable: z
        .enum(['error', 'warn'])
        .optional()
        .describe('Whether an undecided assertion reaches the outcome. Defaults to error; only lower it if the user asked.'),
    },
  },
  async ({ scenarioId, datasetId, unevaluable }) =>
    guarded(async () => {
      const s = await workspace();
      const loaded = await s.scenarios();
      const found = loaded.find((entry) => entry.scenario.id === scenarioId);
      if (!found) {
        return fail(
          `No scenario \`${scenarioId}\`. There is: ${loaded.map((e) => e.scenario.id).join(', ') || '(none)'}.`,
        );
      }
      const datasets = found.scenario.datasets.filter((d) => !datasetId || d.id === datasetId);
      if (datasets.length === 0) {
        return fail(
          `Scenario \`${scenarioId}\` has no dataset \`${datasetId}\`. It has: ${found.scenario.datasets
            .map((d) => d.id)
            .join(', ')}.`,
        );
      }

      const policy: VerdictPolicy = { ...DEFAULT_POLICY, ...(unevaluable ? { unevaluable } : {}) };
      const startedAt = new Date().toISOString();
      await s.preflight();

      const reports: Parameters<typeof buildEnvelope>[0][number][] = [];
      const verdicts: RunVerdict[] = [];
      for (const dataset of datasets) {
        const scope = await s.scopeFor(found.scenario);
        const run = await s.engine.run(found.scenario, dataset.id, scope);
        const verdict = verdictOf(run, policy);
        verdicts.push(verdict);
        reports.push({
          selector: `${found.scenario.id}/${dataset.id}`,
          scenario: { id: found.scenario.id, title: found.scenario.title, file: found.file },
          dataset: { id: dataset.id, label: dataset.label },
          run,
          verdict,
        });
      }

      const suite = mergeVerdicts(verdicts, policy);
      const envelope = buildEnvelope(reports, suite, {
        producer: { tool: 'statescope', version: '0.3.0', surface: 'mcp' },
        workspace: {
          name: s.config.name,
          configPath: s.config.configFile,
          baseUrl: s.config.baseUrl,
          scenariosDir: s.config.scenariosDir,
          capture: { method: s.adapter.captureMethod, detection: s.adapter.detection },
          tableCount: (await s.adapter.listTables()).length,
        },
        invocation: {
          argv: ['mcp', 'run_scenario'],
          targets: reports.map((r) => r.selector),
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(startedAt),
        },
        policy: {
          ...policy,
          escalatedCodes: suite.warnings.filter((w) => w.severity === 'error').map((w) => w.code),
          baselineWindowMs: s.config.baselineWindowMs ?? 0,
          exitZero: false,
        },
        exitCode: exitCodeOf(suite.outcome),
      });

      for (const single of envelope.runs) {
        await s.history?.save({
          ...single,
          run: { ...single.run, scenarioId: single.scenario.id, datasetId: single.dataset.id },
        } as never);
      }

      // Verdict first, always. An agent reads until it finds something that
      // looks like an answer, and the first thing here has to be the true one.
      return ok(
        [describeVerdict(suite), '', ...envelope.runs.map(describeRun)].join('\n'),
      );
    }),
);

server.registerTool(
  'list_runs',
  {
    description: 'Stored runs, newest first, with the verdict each reached.',
    inputSchema: { limit: z.number().int().positive().max(100).optional() },
  },
  async ({ limit }) =>
    guarded(async () => {
      const s = await workspace();
      if (!s.history) return ok('Run history is off for this session.');
      const rows = await s.history.list(limit ?? 20);
      if (rows.length === 0) return ok('No stored runs yet.');
      return ok(
        rows
          .map(
            (row) =>
              `${row.id}  ${row.outcome.padEnd(10)} ${row.scenarioId}/${row.datasetId}` +
              `${row.coverage === 'partial' ? '  (partial)' : ''}  ${row.startedAt}`,
          )
          .join('\n'),
      );
    }),
);

server.registerTool(
  'get_run',
  {
    description: 'One stored run in full, as the machine envelope. Use it to inspect a diff you did not keep in context.',
    inputSchema: { runId: z.string().describe('A run id from list_runs, or "last".') },
  },
  async ({ runId }) =>
    guarded(async () => {
      const s = await workspace();
      if (!s.history) return fail('Run history is off for this session.');
      const stored = runId === 'last' ? await s.history.latest() : await s.history.get(runId);
      if (!stored) return fail(`No stored run \`${runId}\`. list_runs shows what is there.`);
      return ok(JSON.stringify(stored, null, 2));
    }),
);

server.registerTool(
  'list_tables',
  {
    description: 'Every table StateScope can observe in this database.',
    inputSchema: {},
  },
  async () =>
    guarded(async () => {
      const s = await workspace();
      const { tables } = await s.preflight();
      return ok(tables.join('\n'));
    }),
);

server.registerTool(
  'describe_table',
  {
    description:
      'One table: its columns, types, and how StateScope will identify its rows. A table with no primary key or unique index can be counted but not matched to a previous version, and assertions over it are weaker.',
    inputSchema: { table: z.string() },
  },
  async ({ table }) =>
    guarded(async () => {
      const s = await workspace();
      const scope = await s.adapter.fullScope();
      const entry = scope.tables.find((t) => t.table === table);
      if (!entry) {
        return fail(
          `No table \`${table}\`. There is: ${scope.tables.map((t) => t.table).join(', ')}.`,
        );
      }
      const { changes } = await s.adapter.capture(
        { allTables: false, tables: [entry] },
        async () => undefined,
      );
      return ok(
        [
          `${table}`,
          `  row identity  ${entry.keyStrategy}${
            entry.keyStrategy === 'full-row-multiset'
              ? ' — no primary key or unique index, so rows here can be counted but not matched'
              : ''
          }`,
          `  ignored       ${entry.ignoreColumns.join(', ') || '(none)'}`,
          `  masked        ${entry.maskedColumns.join(', ') || '(none)'}`,
          `  capture       ${changes.captureMethod}, ${changes.detection} detection`,
        ].join('\n'),
      );
    }),
);

server.registerTool(
  'write_scenario',
  {
    description:
      'Create or replace a scenario file. It is validated before it lands: a file that will not parse, or whose assertions will not parse, is refused and nothing is written. Call check_scenarios afterwards to see whether its table names resolve.',
    inputSchema: {
      scenarioId: z.string().describe('Becomes <scenarioId>.yaml in the scenarios directory.'),
      yaml: z.string().describe('The whole file. Must start with `version: 1`.'),
    },
  },
  async ({ scenarioId, yaml }) =>
    guarded(async () => {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(scenarioId)) {
        return fail(`\`${scenarioId}\` is not a usable file name. Use letters, digits, - and _.`);
      }
      const s = await workspace();
      const path = resolve(s.config.scenariosDir, `${scenarioId}.yaml`);

      // Validated by writing to a temporary path and loading it, so a file that
      // will not parse never replaces one that does.
      const temp = `${path}.mcp-tmp`;
      await writeFile(temp, yaml, 'utf8');
      try {
        const scenario = await loadScenario(temp);
        if (scenario.id !== scenarioId) {
          return fail(`The file declares \`id: ${scenario.id}\` but was written as \`${scenarioId}\`.`);
        }
        await writeFile(path, yaml, 'utf8');
        return ok(
          `Wrote ${path}\n${scenario.datasets.length} dataset(s), ` +
            `${scenario.datasets.reduce((n, d) => n + d.steps.length, 0)} steps.\n\n` +
            `Run check_scenarios next — it resolves the table names, which parsing does not.`,
        );
      } catch (error) {
        // The temporary path is an implementation detail; naming it in the
        // error sends an agent looking for a file that no longer exists.
        const detail = (error instanceof Error ? error.message : String(error)).replaceAll(
          temp,
          `${scenarioId}.yaml`,
        );
        return fail(`Not written — the file would not load:\n${detail}`);
      } finally {
        await import('node:fs/promises').then(({ rm }) => rm(temp, { force: true }));
      }
    }),
);

server.registerTool(
  'list_assertion_candidates',
  {
    description:
      'The assertions a stored run\'s own changes imply, ready to keep. Prefer these to writing assertions by hand from a diff: generated ids are already replaced by the variables that produced them, so the assertion survives the next run.',
    inputSchema: {
      runId: z.string().describe('A run id, or "last".'),
      stepId: z.string(),
    },
  },
  async ({ runId, stepId }) =>
    guarded(async () => {
      const s = await workspace();
      if (!s.history) return fail('Run history is off for this session.');
      const stored = runId === 'last' ? await s.history.latest() : await s.history.get(runId);
      if (!stored) return fail(`No stored run \`${runId}\`.`);
      const steps = (stored['steps'] ?? []) as Array<{
        id: string;
        candidates?: Array<{ expression: string; description: string; caveat?: { message: string } }>;
      }>;
      const step = steps.find((entry) => entry.id === stepId);
      if (!step) {
        return fail(`Run \`${stored.run.id}\` has no step \`${stepId}\`. It has: ${steps.map((x) => x.id).join(', ')}.`);
      }
      const candidates = step.candidates ?? [];
      if (candidates.length === 0) return ok(`Step \`${stepId}\` changed nothing that suggests an assertion.`);
      return ok(
        candidates
          .map(
            (candidate, index) =>
              `${index + 1}. ${candidate.expression}\n   ${candidate.description}` +
              (candidate.caveat ? `\n   caveat: ${candidate.caveat.message}` : ''),
          )
          .join('\n'),
      );
    }),
);

server.registerTool(
  'keep_assertion',
  {
    description:
      'Write one assertion into a scenario file. Adds a single line and reformats nothing else. Refuses an expression that does not parse, so a bad one cannot leave the scenario unloadable.',
    inputSchema: {
      scenarioId: z.string(),
      datasetId: z.string(),
      stepId: z.string(),
      expression: z.string().describe('Usually taken verbatim from list_assertion_candidates.'),
    },
  },
  async ({ scenarioId, datasetId, stepId, expression }) =>
    guarded(async () => {
      const s = await workspace();
      const found = (await s.scenarios()).find((entry) => entry.scenario.id === scenarioId);
      if (!found) return fail(`No scenario \`${scenarioId}\`.`);
      const result = await addAssertion({ file: found.file, datasetId, stepId, expression });
      return ok(
        result.added
          ? `Kept in ${found.file}\n  ${expression}\n\n${scenarioId}/${datasetId}/${stepId} now has ${result.assertions.length} assertion(s). Run it again to see it evaluated.`
          : `Already there — nothing written.\n  ${expression}`,
      );
    }),
);

// ─── lifecycle ────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  // The pools hold libuv handles; without this the process outlives its client.
  await Promise.race([
    session?.close().catch(() => {}) ?? Promise.resolve(),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await server.connect(new StdioServerTransport());

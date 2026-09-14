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
} from '@tuplescope/core';
import { buildEnvelope, RUN_REPORT_SCHEMA } from '@tuplescope/report';
import {
  addAssertion,
  auditScenarios,
  formatProblem,
  loadScenario,
  ScenarioLoadError,
} from '@tuplescope/scenario-engine';
import {
  loadWorkspace,
  openWorkspace,
  WorkspaceError,
  type WorkspaceSession,
} from '@tuplescope/workspace';
import { parseServerArgs, USAGE } from './args.js';
import { INSTRUCTIONS } from './instructions.js';
import {
  describeScope,
  describeTable,
  describeVerdict,
  noSuchScenario,
  noSuchStep,
  notWritten,
  runIsError,
} from './messages.js';

// ─── one session, opened lazily ───────────────────────────────────────────────

/** The command line, read before anything can need the workspace it names. */
const args = parseServerArgs(process.argv.slice(2));

let session: WorkspaceSession | undefined;
/**
 * Removes resolved credentials from text this process did not format — a
 * driver's message with the connection string inline, on its way to an agent's
 * transcript. Identity until the workspace has resolved its secrets.
 */
let scrub: (text: string) => string = (text) => text;

async function workspace(): Promise<WorkspaceSession> {
  if (session) return session;
  // Load and resolve, through the one door. This used to load and open — and
  // a workspace with a `${secret:…}` reference in it could not be served.
  const resolved = await loadWorkspace({ configPath: args.kind === 'serve' ? args.configPath : undefined });
  scrub = resolved.scrub;
  session = openWorkspace(resolved.config, { history: { keep: 50 } });
  return session;
}

/** Every tool answers as text; an agent reads prose better than a JSON blob. */
type Result = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

// Both go through the scrubber. `ok` used to pass its text straight through, so
// an API that echoed a credential into a field an assertion reports would have
// printed it in the clear here, while the CLI scrubs everything it writes.
const ok = (text: string): Result => ({ content: [{ type: 'text', text: scrub(text) }] });
const fail = (text: string): Result => ({ content: [{ type: 'text', text: scrub(text) }], isError: true });

async function guarded(body: () => Promise<Result>): Promise<Result> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof WorkspaceError) {
      return fail(`${error.message}${error.remedy ? `\n\n${error.remedy}` : ''}`);
    }
    if (error instanceof ScenarioLoadError) {
      // The message names the file and the fault. What it cannot say is that
      // every tool reading scenarios stops at the first file that will not
      // load, so this one blocks all of them until it is dealt with.
      return fail(
        `${error.message}\n\nEvery tool that reads scenarios stops at this file until it loads. ` +
          'Fix it — write_scenario replaces a file whole — or move it out of the scenarios directory.',
      );
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ─── how a verdict is spoken ──────────────────────────────────────────────────

// The verdict itself is spoken by `describeVerdict` in messages.ts, where it can
// be tested without a server; this is the run beneath it.
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

/**
 * One place, so the handshake and the envelope's `producer` cannot drift apart.
 *
 * They were two literals, which is the shape that goes stale on the next bump:
 * every stored envelope would carry a version the server no longer reports, and
 * nothing would say so.
 */
const VERSION = '0.4.0';

const server = new McpServer(
  { name: 'tuplescope', version: VERSION },
  { instructions: INSTRUCTIONS },
);

server.registerTool(
  'describe_workspace',
  {
    description:
      'What this workspace points at: the API under test, the database, the capture engine, and the tables it can observe — and what it does not watch, or watches only partly: tables outside its schema, and tables with no primary key or unique index, with what each costs. Call this first — it is what tells you whether a scenario you write will resolve.',
    inputSchema: {},
  },
  async () =>
    guarded(async () => {
      const s = await workspace();
      const { tables, scope } = await s.preflight();
      const scenarios = await s.scenarios();
      // Whether a row leaving a keyless table can be seen is a fact about the
      // engine and the table together, so it is read off the scope the engine
      // builds — never inferred from the engine's name.
      const observable =
        scope.keyless.length > 0
          ? new Map((await s.adapter.fullScope()).tables.map((t) => [t.table, t.departuresObservable !== false]))
          : new Map<string, boolean>();
      return ok(
        [
          `workspace   ${s.config.name}`,
          `api         ${s.config.baseUrl}`,
          `config      ${s.config.configFile}`,
          `scenarios   ${s.config.scenariosDir} (${scenarios.length} file(s))`,
          `capture     ${s.adapter.captureMethod}, ${s.adapter.detection} detection, ` +
            `${s.adapter.fidelity} fidelity` +
            (s.adapter.fidelity === 'transactional'
              ? ' — atomic() and writeCount() will resolve here'
              : ' — atomic() and writeCount() would come back undecided'),
          `identities  ${s.config.identities?.map((i) => i.id).join(', ') || '(none configured)'}`,
          `ignored     ${s.config.ignoreColumns?.join(', ') || '(none)'}`,
          `baseline    ${s.config.baselineWindowMs ? `${s.config.baselineWindowMs} ms idle probe` : 'not probed — concurrent writes would not be detected'}`,
          '',
          `tables (${tables.length}) in \`${scope.schema}\`: ${tables.join(', ')}`,
          // What it does not watch, or watches only partly. This listed the
          // tables and stopped, so a keyless one read like any other and the
          // first an agent heard of it was an undecided run.
          ...describeScope({
            ...scope,
            // Unknown reads as unobservable: the weaker claim about the capture.
            keyless: scope.keyless.map((table) => ({ table, departuresObservable: observable.get(table) ?? false })),
          }),
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
      const loaded = await s.scenarios();
      const found = loaded.find((entry) => entry.scenario.id === scenarioId);
      if (!found) return fail(noSuchScenario(scenarioId, loaded.map((entry) => entry.scenario.id)));
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
      const all = await s.scenarios();
      // An id that names no file is a mistake in the call, not a suite with
      // nothing in it. This answered "0 scenario(s) selected" — true, and no
      // help to an agent that had misspelled the id, when get_scenario names
      // the typo and lists what exists for the same input. `tuplescope check
      // nosuch` refuses it the same way, as a bad invocation (exit 4), and
      // before touching the database: naming a typo needs none.
      if (scenarioId && !all.some((entry) => entry.scenario.id === scenarioId)) {
        return fail(noSuchScenario(scenarioId, all.map((entry) => entry.scenario.id)));
      }
      // `columns` too. Destructuring only `tables` was the whole reason this
      // tool was weaker than `tuplescope check`: it could see a misspelled
      // table and not a misspelled predicate column, which is the one that
      // stays green forever.
      const { tables, columns } = await s.preflight();
      const known = new Set(tables);
      const loaded = all.filter((entry) => !scenarioId || entry.scenario.id === scenarioId);
      const selected = loaded.flatMap(({ scenario }) =>
        scenario.datasets.map((dataset) => ({ scenario, dataset })),
      );
      // The same function `tuplescope check` calls. These were two
      // implementations describing themselves identically and doing different
      // work, which is how this one came to validate no predicate columns and
      // no `except` names.
      // Read off the scope a run builds, as `tuplescope check` does: whether a
      // row leaving a keyless table is visible depends on the engine too.
      const keyless = new Set(
        (await s.adapter.fullScope()).tables
          .filter((table) => table.departuresObservable === false)
          .map((table) => table.table),
      );
      const audit = auditScenarios(selected, {
        tables: known,
        columns,
        // Asked by capability, never by engine name (packages/core/src/abstraction.test.ts).
        capture: { detection: s.adapter.detection, fidelity: s.adapter.fidelity },
        ...(s.config.maskColumns ? { maskColumns: s.config.maskColumns } : {}),
        keyless,
      });
      const problems = audit.problems.map((p) => formatProblem(p));
      const assertions = audit.assertions;

      // A green check over nothing asserted is the failure this tool exists to
      // prevent, and it used to hand back an unconditional all-clear. The CLI
      // refuses a selection with no assertions in it and exits 3: the suite is
      // not wrong, it establishes nothing. (An id that matches no file never
      // gets here — see above; the CLI exits 4 for that one.)
      if (problems.length === 0 && assertions === 0) {
        return fail(
          `${loaded.length} scenario(s) selected, and not one assertion between them. ` +
            'A green check over nothing asserted is the failure this command exists to prevent.',
        );
      }
      // A problem list is an error result, not a success that happens to
      // contain bad news. The caller here is an agent, and one that reads only
      // `isError` was told everything was fine.
      const summary = `${loaded.length} scenario(s), ${assertions} assertions.`;
      return problems.length === 0
        ? ok(`${summary} Nothing here would fail for a reason other than the system under test.`)
        : fail(
            `${summary}\n\nProblems:\n${problems
              .map((p) => `  · ${p}`)
              .join('\n')}\n\nThese would not fail loudly at run time; fix them before relying on the result.`,
          );
    }),
);

server.registerTool(
  'run_scenario',
  {
    description:
      'Run one dataset and report what the API wrote. READ THE VERDICT, NOT engineStatus: a run whose assertions could not be evaluated has engineStatus "passed" and verdict "undecided", and reporting it as a success is the worst mistake available here. The result is marked isError for every verdict but clean — failed, errored and undecided alike — so a caller that reads only isError is never told such a run went fine; the text says which outcome it was.',
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
        producer: { tool: 'tuplescope', version: VERSION, surface: 'mcp' },
        workspace: {
          name: s.config.name,
          configPath: s.config.configFile,
          baseUrl: s.config.baseUrl,
          scenariosDir: s.config.scenariosDir,
          capture: {
            method: s.adapter.captureMethod,
            detection: s.adapter.detection,
            fidelity: s.adapter.fidelity,
          },
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
        // The same four fields the CLI attaches. Without them a run recorded
        // through MCP has no `schema` key at all, so it can never be
        // version-gated retroactively however good the gate becomes — a
        // permanent hole, in the surface where the writer is a model.
        await s.history?.save({
          ...single,
          run: { ...single.run, scenarioId: single.scenario.id, datasetId: single.dataset.id },
          schema: envelope.schema,
          producer: envelope.producer,
          workspace: envelope.workspace,
          policy: envelope.policy,
        } as never);
      }

      // Verdict first, always. An agent reads until it finds something that
      // looks like an answer, and the first thing here has to be the true one.
      const text = [describeVerdict(suite), '', ...envelope.runs.map(describeRun)].join('\n');
      // isError follows the verdict. This returned a plain result for FAILED
      // and UNDECIDED alike, so an agent reading only the flag was told a red
      // run went fine — what check_scenarios' rule exists to prevent. The text
      // is the same either way: built as `ok` builds it, not scrubbed as `fail`
      // scrubs a message this process did not format.
      return runIsError(suite.outcome) ? { ...ok(text), isError: true } : ok(text);
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
    description:
      'One stored run in full: its verdict in prose, then the machine envelope. Use it to inspect a diff you did not keep in context.',
    inputSchema: { runId: z.string().describe('A run id from list_runs, or "last".') },
  },
  async ({ runId }) =>
    guarded(async () => {
      const s = await workspace();
      if (!s.history) return fail('Run history is off for this session.');
      const stored = runId === 'last' ? await s.history.latest() : await s.history.get(runId);
      if (!stored) return fail(`No stored run \`${runId}\`. list_runs shows what is there.`);
      // Verdict first, in the words run_scenario uses. This returned the bare
      // envelope, which opens with `selector`, `scenario` and `dataset`: the
      // verdict was an object further down, and the first thing that looked
      // like an answer could be `engineStatus: "passed"` on an undecided run.
      return ok(`${describeVerdict(stored['verdict'] as RunVerdict)}\n\n${JSON.stringify(stored, null, 2)}`);
    }),
);

server.registerTool(
  'list_tables',
  {
    description: 'Every table TupleScope can observe in this database.',
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
      'One table: its columns and their declared types, which of them the workspace ignores or masks, and how TupleScope will identify its rows. A table with no primary key or unique index can be counted but not matched to a previous version, and assertions over it are weaker.',
    inputSchema: { table: z.string() },
  },
  async ({ table }) =>
    guarded(async () => {
      const s = await workspace();
      // Through `preflight`, like every other tool that reads the catalogue.
      // This went straight to the adapter, and an unreachable database came
      // back as the driver's bare `connect ECONNREFUSED 127.0.0.1:1` — no
      // workspace, no key, no remedy — where its siblings named all three.
      await s.preflight();
      // Declared types, in table order (`format_type`, so `numeric(18,8)`).
      // Asked only once the preflight has answered, so an unreachable database
      // still arrives in its siblings' words.
      const columns = await s.adapter.listColumnTypes();
      const scope = await s.adapter.fullScope();
      const entry = scope.tables.find((t) => t.table === table);
      if (!entry) {
        return fail(
          `No table \`${table}\`. There is: ${scope.tables.map((t) => t.table).join(', ')}.`,
        );
      }
      const { changes } = await s.adapter.capture(
        { schema: scope.schema, database: scope.database, allTables: false, tables: [entry] },
        async () => undefined,
      );
      return ok(
        describeTable({
          table,
          keyStrategy: entry.keyStrategy,
          columns: [...(columns.get(table) ?? [])],
          ignoreColumns: s.config.ignoreColumns ?? [],
          maskColumns: s.config.maskColumns ?? [],
          capture: { method: changes.captureMethod, detection: changes.detection, fidelity: changes.fidelity },
        }),
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
      try {
        await writeFile(temp, yaml, 'utf8');
      } catch (error) {
        return fail(
          notWritten(error, { temp, file: path, scenariosDir: s.config.scenariosDir, configFile: s.config.configFile }),
        );
      }
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
      if (!stored) return fail(`No stored run \`${runId}\`. list_runs shows what is there.`);
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
      const loaded = await s.scenarios();
      const found = loaded.find((entry) => entry.scenario.id === scenarioId);
      if (!found) return fail(noSuchScenario(scenarioId, loaded.map((entry) => entry.scenario.id)));
      // Checked against the loaded scenario so the refusal can list what is
      // there; the file edit would refuse too, naming only the miss.
      const missing = noSuchStep(found.scenario, datasetId, stepId);
      if (missing) return fail(missing);
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
    // `unref`'d: a deadline that loses its race must not then hold the process
    // open until it fires. Harmless today because `process.exit` follows, and a
    // trap for whoever removes that line thinking Node can now exit on its own
    // — the identical shape in the CLI cost every command a flat two seconds.
    new Promise((r) => {
      setTimeout(r, 2000).unref();
    }),
  ]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

if (args.kind === 'version') {
  // The CLI's line, with this binary's name. Imported rather than typed out,
  // for the reason `tuplescope --version` gives.
  process.stdout.write(`tuplescope-mcp ${VERSION} (schema ${RUN_REPORT_SCHEMA})\n`);
} else if (args.kind === 'help') {
  process.stdout.write(USAGE);
} else if (args.kind === 'refused') {
  // 4 is this CLI's "bad invocation"; `exitCode` rather than `exit()` so the
  // message is not cut off on a pipe.
  process.stderr.write(args.message);
  process.exitCode = 4;
} else {
  await server.connect(new StdioServerTransport());
}

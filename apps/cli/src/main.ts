#!/usr/bin/env node
/**
 * `statescope` — the headless surface.
 *
 * It drives the engine in-process and never speaks to the HTTP runtime. CI has
 * no server to talk to, and requiring one would mean starting a web server,
 * waiting on a health check and managing a token for a localhost process the
 * job just launched. The composition root in `@statescope/workspace` is what
 * makes that possible; this file is argument parsing, ordering and output.
 *
 * Two process rules, both load-bearing:
 *
 *   - `process.exitCode`, never `process.exit()`. Piped stdout writes are
 *     async, and exiting truncates the report the exit code is describing.
 *   - The adapter must be closed or Node never exits: idle pool sockets hold
 *     libuv handles. Exit-code correctness and connection cleanup are the same
 *     problem, so `close()` is raced against a timeout and a last-resort
 *     unref'd timer guarantees an exit even with a stranded socket.
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  DEFAULT_POLICY,
  exitCodeOf,
  mergeVerdicts,
  verdictOf,
  type RunVerdict,
  type VerdictPolicy,
} from '@statescope/core';
import { buildEnvelope, toJUnit } from '@statescope/report';
import { loadWorkspaceConfig, openWorkspace, WorkspaceConfigError, WorkspaceError } from '@statescope/workspace';
import { listSessions } from './sessions.js';
import { renderRun, renderWorkspaceLine, styleFor } from './output.js';

/** Codes a run can produce come from core. These are the CLI's own. */
const EXIT_USAGE = 4;
const EXIT_NOTHING_SELECTED = 5;

const OPTIONS = {
  config: { type: 'string' },
  json: { type: 'boolean' },
  junit: { type: 'string' },
  dataset: { type: 'string', short: 'd' },
  from: { type: 'string' },
  only: { type: 'string' },
  unevaluable: { type: 'string' },
  warnings: { type: 'string' },
  'require-assertions': { type: 'boolean' },
  baseline: { type: 'string' },
  diff: { type: 'string' },
  columns: { type: 'string' },
  wide: { type: 'boolean' },
  'exit-zero': { type: 'boolean' },
  'pass-with-no-scenarios': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  ascii: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

const HELP = `statescope — run backend scenarios, see exactly what changed

  statescope run [target…]     run scenarios and report what the API wrote
  statescope ls                every scenario and dataset in this workspace
  statescope status            what this workspace points at, and whether it answers
  statescope url               the URL of a running runtime, token and all

A target is scenario[/dataset]. With none, every dataset runs.

Run options
  -d, --dataset <id>           shorthand for one dataset of one scenario
      --from <stepId>          start at this step and run to the end
      --only <stepId>          run this step alone
      --unevaluable <mode>     error | warn        whether an undecided check
                               reaches the exit code                 (error)
      --warnings <mode>        default | strict | off                (default)
      --require-assertions     a run that checked nothing exits 3
      --baseline <ms|off>      idle window watched before the run
      --exit-zero              cap outcomes 1 and 3 at 0; never masks 2, 4, 5

Output
      --json                   the machine envelope on stdout
      --junit <path>           JUnit XML; - for stdout
      --diff <mode>            auto | all | failed | none            (auto)
      --columns <n|all>        columns per inserted row              (4)
      --wide                   do not truncate values
  -q, --quiet                  the summary only
      --no-color, --ascii      for terminals and log viewers that need it

Exit codes
  0  every check evaluated and passed
  1  a check failed — the system under test is wrong
  2  a step could not be executed
  3  undecided — it ran, nothing failed, but something was never checked
  4  bad invocation, or a workspace that will not load
  5  the target matched no dataset
`;

async function main(argv: string[]): Promise<number> {
  // The return type depends on `allowPositionals`, so it has to be part of the
  // annotation or `positionals` infers as the empty tuple.
  type Parsed = ReturnType<
    typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
  >;
  let parsed: Parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write('statescope 0.2.0 (schema statescope.run-report/1)\n');
    return 0;
  }
  const command = positionals[0] ?? (values.help ? 'help' : undefined);
  if (!command || command === 'help' || values.help) {
    process.stdout.write(HELP);
    return command && command !== 'help' ? EXIT_USAGE : 0;
  }

  switch (command) {
    case 'url':
      return commandUrl(positionals.slice(1));
    case 'run':
      return commandRun(positionals.slice(1), values, argv);
    case 'ls':
      return commandList(values);
    case 'status':
      return commandStatus(values);
    default:
      process.stderr.write(`Unknown command \`${command}\`.\n\n${HELP}`);
      return EXIT_USAGE;
  }
}

// ─── url ──────────────────────────────────────────────────────────────────────

function commandUrl(args: string[]): number {
  const sessions = listSessions();
  if (sessions.length === 0) {
    process.stderr.write(
      'No StateScope runtime is running.\nStart one with `statescope serve`; it prints its URL and records it for next time.\n',
    );
    return 1;
  }
  if (args.includes('--all')) {
    for (const s of sessions) {
      process.stdout.write(`${s.url}    ${s.workspace} (pid ${s.pid}, since ${s.startedAt})\n`);
    }
    return 0;
  }
  process.stdout.write(`${sessions[0]!.url}\n`);
  if (sessions.length > 1) {
    process.stderr.write(`(${sessions.length - 1} other instance(s) running — statescope url --all)\n`);
  }
  return 0;
}

// ─── shared setup ─────────────────────────────────────────────────────────────

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values'];

function policyFrom(values: Values): VerdictPolicy | string {
  const unevaluable = values.unevaluable ?? DEFAULT_POLICY.unevaluable;
  if (unevaluable !== 'error' && unevaluable !== 'warn') {
    return `--unevaluable must be \`error\` or \`warn\`, not \`${unevaluable}\``;
  }
  const warnings = values.warnings ?? DEFAULT_POLICY.warnings;
  if (warnings !== 'default' && warnings !== 'strict' && warnings !== 'off') {
    return `--warnings must be \`default\`, \`strict\` or \`off\`, not \`${warnings}\``;
  }
  return {
    unevaluable,
    warnings,
    requireAssertions: values['require-assertions'] ?? DEFAULT_POLICY.requireAssertions,
  };
}

async function withWorkspace<T>(
  values: Values,
  body: (session: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T | number> {
  let session: Awaited<ReturnType<typeof open>>;
  try {
    session = await open(values);
  } catch (error) {
    if (error instanceof WorkspaceConfigError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  try {
    return await body(session);
  } finally {
    // Racing the close is what stops Ctrl-C mid-request from waiting out the
    // HTTP timeout: the observer client is held across the step.
    await Promise.race([session.close().catch(() => {}), sleep(2000)]);
  }
}

async function open(values: Values) {
  const config = await loadWorkspaceConfig({
    ...(values.config !== undefined ? { configPath: values.config } : {}),
  });
  const baseline = values.baseline;
  return openWorkspace(config, {
    ...(baseline !== undefined
      ? { baselineWindowMs: baseline === 'off' ? 0 : Number(baseline) }
      : {}),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── ls / status ──────────────────────────────────────────────────────────────

async function commandList(values: Values): Promise<number> {
  const result = await withWorkspace(values, async (session) => {
    const loaded = await session.scenarios();
    const style = styleFor(values);
    const out: string[] = [renderWorkspaceLine(style, session.config)];
    for (const { scenario } of loaded) {
      out.push('', `  ${scenario.id}  ${scenario.title}`);
      for (const dataset of scenario.datasets) {
        out.push(
          `    ${scenario.id}/${dataset.id}`.padEnd(34) +
            `${dataset.label}  (${dataset.steps.length} steps)`,
        );
      }
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  });
  return typeof result === 'number' ? result : 0;
}

async function commandStatus(values: Values): Promise<number> {
  const result = await withWorkspace(values, async (session) => {
    const style = styleFor(values);
    process.stdout.write(`${renderWorkspaceLine(style, session.config)}\n`);
    try {
      const { tables } = await session.preflight();
      process.stdout.write(`  database  reachable · ${tables.length} tables\n`);
    } catch (error) {
      const message = error instanceof WorkspaceError ? error.message : String(error);
      const remedy = error instanceof WorkspaceError ? error.remedy : undefined;
      process.stderr.write(`  database  ${message}\n${remedy ? `            ${remedy}\n` : ''}`);
      return 2;
    }
    try {
      const response = await fetch(new URL('/', session.config.baseUrl), {
        signal: AbortSignal.timeout(3000),
      });
      process.stdout.write(`  backend   answering · HTTP ${response.status}\n`);
    } catch {
      process.stdout.write(
        `  backend   nothing is listening at ${session.config.baseUrl}\n` +
          `            Start it, then run again.\n`,
      );
      return 2;
    }
    return 0;
  });
  return typeof result === 'number' ? result : 0;
}

// ─── run ──────────────────────────────────────────────────────────────────────

async function commandRun(targets: string[], values: Values, argv: string[]): Promise<number> {
  const policy = policyFrom(values);
  if (typeof policy === 'string') {
    process.stderr.write(`${policy}\n`);
    return EXIT_USAGE;
  }
  if ((values.from ?? values.only) !== undefined && targets.length !== 1) {
    process.stderr.write('--from and --only need exactly one target, so it is clear which dataset they mean.\n');
    return EXIT_USAGE;
  }

  const startedAt = new Date().toISOString();
  const result = await withWorkspace(values, async (session) => {
    const style = styleFor(values);
    const loaded = await session.scenarios();

    const selected = select(loaded, targets, values.dataset);
    if (typeof selected === 'string') {
      process.stderr.write(`${selected}\n`);
      return EXIT_USAGE;
    }
    if (selected.length === 0) {
      const message = targets.length
        ? `No dataset matched ${targets.map((t) => `\`${t}\``).join(', ')}.`
        : 'This workspace has no scenarios.';
      process.stderr.write(`${message}\n`);
      return values['pass-with-no-scenarios'] ? 0 : EXIT_NOTHING_SELECTED;
    }

    // Everything that can fail because the world is not ready happens here, so
    // exit 2 and exit 4 honestly mean the database is untouched.
    try {
      await session.preflight();
    } catch (error) {
      const workspaceError = error instanceof WorkspaceError ? error : undefined;
      process.stderr.write(`${workspaceError?.message ?? String(error)}\n`);
      if (workspaceError?.remedy) process.stderr.write(`${workspaceError.remedy}\n`);
      return 2;
    }

    const reports: Array<Parameters<typeof buildEnvelope>[0][number]> = [];
    const verdicts: RunVerdict[] = [];

    for (const { scenario, dataset, file } of selected) {
      let scope;
      try {
        scope = await session.scopeFor(scenario);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_USAGE;
      }
      let run;
      try {
        run = await session.engine.run(scenario, dataset.id, scope, {
          ...(values.from !== undefined ? { fromStepId: values.from } : {}),
          ...(values.only !== undefined ? { onlyStepId: values.only } : {}),
        });
      } catch (error) {
        // A reset that could not run, or a partial run with no variables to
        // carry, throws before any step result exists — so there is no Run to
        // build a verdict from and the error has to be reported here. A stack
        // trace is the wrong answer for the most ordinary CI failure there is.
        if (error instanceof WorkspaceError) {
          process.stderr.write(`${error.message}\n`);
          if (error.remedy) process.stderr.write(`${error.remedy}\n`);
          return 2;
        }
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return error instanceof Error && /has no step|has no dataset/.test(error.message)
          ? EXIT_USAGE
          : 2;
      }
      const verdict = verdictOf(run, policy);
      verdicts.push(verdict);
      reports.push({
        selector: `${scenario.id}/${dataset.id}`,
        scenario: { id: scenario.id, title: scenario.title, file },
        dataset: { id: dataset.id, label: dataset.label },
        run,
        verdict,
      });
      if (!values.json) {
        process.stdout.write(`${renderRun(style, values, session.config, run, verdict).join('\n')}\n`);
      }
    }

    const suite = mergeVerdicts(verdicts, policy);
    const natural = exitCodeOf(suite.outcome);
    // --exit-zero caps 1 and 3 only. 2, 4 and 5 pass through: it is for "we
    // know, we're fixing it", not for making CI stop reporting the truth.
    const exitCode = values['exit-zero'] && (natural === 1 || natural === 3) ? 0 : natural;

    const envelope = buildEnvelope(reports, suite, {
      producer: { tool: 'statescope', version: '0.2.0', surface: 'cli' },
      workspace: {
        name: session.config.name,
        configPath: session.config.configFile,
        baseUrl: session.config.baseUrl,
        scenariosDir: session.config.scenariosDir,
        capture: { method: session.adapter.captureMethod, detection: session.adapter.detection },
        tableCount: (await session.adapter.listTables()).length,
      },
      invocation: {
        argv,
        targets,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.parse(new Date().toISOString()) - Date.parse(startedAt),
      },
      policy: {
        ...policy,
        escalatedCodes: suite.warnings.filter((w) => w.severity === 'error').map((w) => w.code),
        baselineWindowMs: session.config.baselineWindowMs ?? 0,
        exitZero: values['exit-zero'] ?? false,
      },
      exitCode,
    });

    if (values.json) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    if (values.junit !== undefined) {
      const xml = toJUnit(envelope);
      if (values.junit === '-') process.stdout.write(xml);
      // Written synchronously: a report the exit code refers to must exist
      // before the process leaves, even on a signal.
      else writeFileSync(values.junit, xml, 'utf8');
    }
    // `--quiet` means the summary alone, not silence: the outcome line is the
    // one thing a human always needs, and suppressing it made the flag useless.
    if (!values.json) {
      const { renderSummary } = await import('./render.js');
      process.stdout.write(`${renderSummary(styleFor(values), suite as RunVerdict, exitCode).join('\n')}\n`);
    }
    return exitCode;
  });

  return typeof result === 'number' ? result : 0;
}

interface Selected {
  scenario: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['scenarios']>>[number]['scenario'];
  dataset: Selected['scenario']['datasets'][number];
  file: string;
}

/**
 * Resolves `scenario[/dataset]` targets against what is on disk.
 *
 * A bare scenario name runs *every* dataset, never the first: a scenario ships
 * a happy path plus the datasets that trip its guards, and quietly running one
 * of them would report a fraction of the suite as the whole.
 */
function select(
  loaded: Array<{ scenario: Selected['scenario']; file: string }>,
  targets: string[],
  datasetFlag: string | undefined,
): Selected[] | string {
  const all: Selected[] = loaded.flatMap(({ scenario, file }) =>
    scenario.datasets.map((dataset) => ({ scenario, dataset, file })),
  );
  if (targets.length === 0 && datasetFlag === undefined) return all;

  if (datasetFlag !== undefined) {
    if (targets.length !== 1) return '--dataset needs exactly one scenario as its target.';
    const wanted = all.filter((s) => s.scenario.id === targets[0] && s.dataset.id === datasetFlag);
    if (wanted.length === 0) {
      const known = all.filter((s) => s.scenario.id === targets[0]).map((s) => s.dataset.id);
      return known.length
        ? `Scenario \`${targets[0]}\` has no dataset \`${datasetFlag}\`. It has: ${known.join(', ')}.`
        : `No scenario \`${targets[0]}\`.`;
    }
    return wanted;
  }

  const out: Selected[] = [];
  for (const target of targets) {
    const [scenarioId, datasetId] = target.split('/');
    const matched = all.filter(
      (s) => s.scenario.id === scenarioId && (datasetId === undefined || s.dataset.id === datasetId),
    );
    if (matched.length === 0) {
      const scenarios = [...new Set(all.map((s) => s.scenario.id))];
      return `No dataset matched \`${target}\`. Scenarios here: ${scenarios.join(', ') || '(none)'}.`;
    }
    out.push(...matched);
  }
  return out;
}

// ─── entry ────────────────────────────────────────────────────────────────────

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    // A socket the pool could not release must not hold the process open for
    // ever; unref'd, so a clean run still exits immediately.
    setTimeout(() => process.exit(code), 3000).unref();
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 2;
  });

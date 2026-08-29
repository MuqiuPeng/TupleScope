#!/usr/bin/env node
/**
 * `tuplescope` — the headless surface.
 *
 * It drives the engine in-process and never speaks to the HTTP runtime. CI has
 * no server to talk to, and requiring one would mean starting a web server,
 * waiting on a health check and managing a token for a localhost process the
 * job just launched. The composition root in `@tuplescope/workspace` is what
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
} from '@tuplescope/core';
import { RUN_REPORT_SCHEMA, buildEnvelope, toJUnit, type Envelope } from '@tuplescope/report';
import {
  StaleRunError,
  WorkspaceConfigError,
  WorkspaceError,
  loadWorkspaceConfig,
  namespaceOf,
  openWorkspace,
  resolveWorkspaceSecrets,
  secretsReferencedBy,
} from '@tuplescope/workspace';
import { addAssertion, ScenarioLoadError } from '@tuplescope/scenario-engine';
import { parse, predicateColumnsIn } from '@tuplescope/expr';
import { listSessions } from './sessions.js';
import { renderRun, renderWorkspaceLine, renderScope, styleFor } from './output.js';
import {
  DEFAULT_CONTEXT,
  SecretNotConfigured,
  secretIdFor,
  SecretStoreUnavailable,
  tryOpenSecretStore,
} from '@tuplescope/secrets';
import { commandHandoff } from './handoff.js';
import { commandSecret } from './secrets.js';

/** One place, so `--version` and the envelope's `producer` cannot drift apart. */
const VERSION = '0.3.0';

/** Codes a run can produce come from core. These are the CLI's own. */
const EXIT_USAGE = 4;
const EXIT_NOTHING_SELECTED = 5;

const OPTIONS = {
  show: { type: 'boolean' },
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
  'continue-from': { type: 'string' },
  'no-save': { type: 'boolean' },
  'exit-zero': { type: 'boolean' },
  'pass-with-no-scenarios': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  ascii: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  // handoff
  as: { type: 'string' },
  origin: { type: 'string' },
  server: { type: 'string' },
  username: { type: 'string' },
  service: { type: 'string' },
  everywhere: { type: 'boolean' },
  'i-know-this-is-not-local': { type: 'boolean' },
} as const;

const HELP = `tuplescope — run backend scenarios, see exactly what changed

  tuplescope run [target…]     run scenarios and report what the API wrote
  tuplescope ls                every scenario and dataset in this workspace
  tuplescope show <target>     one scenario or dataset, in detail
  tuplescope check [target]    what this suite can and cannot prove, without running it
  tuplescope runs [n]          stored runs, newest first
  tuplescope runs show <id>    re-render a stored run (an id, or 'last')
  tuplescope keep <sel> <step> [n…]
                               turn what a run observed into assertions in the
                               scenario file. With no numbers, lists them.
  tuplescope report <file…>    re-render stored envelopes as text or JUnit
  tuplescope secret <cmd>      credentials a workspace refers to but does not contain
  tuplescope handoff <cmd>     open an observed row in a database tool of yours
  tuplescope status            what this workspace points at, and whether it answers
  tuplescope url               the URL of a running runtime, token and all

A target is scenario[/dataset]. With none, every dataset runs.

Run options
  -d, --dataset <id>           shorthand for one dataset of one scenario
      --from <stepId>          start at this step and run to the end
      --only <stepId>          run this step alone
      --continue-from <id>     reuse a stored run's variables; 'last' for the
                               newest full run of the same dataset
      --no-save                do not record this run in .tuplescope/runs
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
  5  this workspace has no scenarios to run
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
    // Imported, not typed out. This line said `/1` for as long as the constant
    // did, and would have gone on saying it after the bump — TypeScript cannot
    // object to a string that happens to be wrong.
    process.stdout.write(`tuplescope ${VERSION} (schema ${RUN_REPORT_SCHEMA})\n`);
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
    case 'show':
      return commandShow(positionals.slice(1), values);
    case 'check':
      return commandCheck(positionals.slice(1), values);
    case 'runs':
      return commandRuns(positionals.slice(1), values);
    case 'keep':
      return commandKeep(positionals.slice(1), values);
    case 'report':
      return commandReport(positionals.slice(1), values);
    case 'status':
      return commandStatus(values);
    case 'secret':
      return commandSecret(positionals.slice(1), values);
    case 'handoff':
      // `values` carries `--config`, so the grant is recorded against the
      // workspace the config names rather than whatever directory the shell
      // happens to be in.
      return commandHandoff(positionals.slice(1), values);
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
      'No TupleScope runtime is running.\nStart one with `pnpm start`; it prints its URL and records it for next time.\n',
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
    process.stderr.write(`(${sessions.length - 1} other instance(s) running — tuplescope url --all)\n`);
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

/**
 * Removes resolved credentials from text this process did not format.
 *
 * A PostgreSQL driver reports an authentication failure with the whole
 * connection string in the message, password included, and that message goes
 * to stderr. Wrapping the value in a `Secret` cannot help there — the string
 * was built by someone else. This is the backstop.
 */
let scrubber: (text: string) => string = (text) => text;

export function scrubSecrets(text: string): string {
  return scrubber(text);
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
      process.stderr.write(`${scrubSecrets(error.message)}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof SecretStoreUnavailable || error instanceof SecretNotConfigured) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  try {
    return await body(session);
  } catch (error) {
    // A stored run this build cannot read is an ordinary, actionable outcome —
    // not a crash. It reached the top as a stack trace *and exited 0*, which
    // in a tool whose exit codes are the contract is the worse half.
    if (error instanceof StaleRunError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    // A workspace that is misconfigured is an ordinary outcome with a remedy,
    // not a crash. `tuplescope status` had always rendered its own properly;
    // every other command answered a missing `scenariosDir` with a Node stack
    // trace — on the second command in the README, on a machine that had done
    // nothing wrong.
    if (error instanceof WorkspaceError) {
      process.stderr.write(`${error.message}\n`);
      if (error.remedy) process.stderr.write(`${error.remedy}\n`);
      return EXIT_USAGE;
    }
    // A scenario file that will not load is a file the user can fix, and the
    // message already names the file, the step and the offset in the
    // expression. It was reaching the top as an unhandled throw — a stack
    // trace and exit 2, "the workspace is not ready", for a typo in a function
    // name. Exit 4 is what the rest of this file uses for "you wrote something
    // this cannot accept".
    if (error instanceof ScenarioLoadError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  } finally {
    // Racing the close is what stops Ctrl-C mid-request from waiting out the
    // HTTP timeout: the observer client is held across the step.
    await Promise.race([session.close().catch(() => {}), sleep(2000)]);
  }
}

async function open(values: Values) {
  const loaded = await loadWorkspaceConfig({
    ...(values.config !== undefined ? { configPath: values.config } : {}),
  });

  // The workspace names credentials; this is where they become values. The
  // store is only opened when something actually refers to one, so a workspace
  // with no secrets never touches the keychain and never prompts.
  const needed = secretsReferencedBy(loaded);
  const opened =
    needed.length > 0
      ? await tryOpenSecretStore({ namespace: namespaceOf(loaded) })
      : { store: undefined, reason: '' };
  const { config, scrub } = await resolveWorkspaceSecrets(loaded, {
    ...('store' in opened && opened.store ? { store: opened.store } : {}),
    ...('reason' in opened && opened.reason ? { storeUnavailable: opened.reason } : {}),
  });
  // Anything formatted from here on can have the values taken back out.
  scrubber = scrub;

  const baseline = values.baseline;
  return openWorkspace(config, {
    ...(baseline !== undefined
      ? { baselineWindowMs: baseline === 'off' ? 0 : Number(baseline) }
      : {}),
    // History is opt-in per surface. The CLI wants it because --continue-from
    // has nowhere else to read from; the runtime and MCP do not.
    history: values['no-save'] ? false : { keep: 50 },
  });
}

/**
 * `unref`'d, so a timer that lost its race cannot keep the process alive.
 *
 * It is used as the losing half of `Promise.race([close(), sleep(2000)])`, and
 * a `setTimeout` holds the event loop open until it fires whether or not
 * anybody is still waiting on it. Measured: `tuplescope ls` finished its work
 * in 16ms and the process then sat for another 2,250ms — every invocation of
 * every command paying two seconds for a deadline that had already been beaten.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

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

/**
 * Whether every secret a workspace refers to is configured — without reading a
 * single value.
 *
 * `status` and `check` are the commands run *because* something is wrong, so
 * they have to survive a missing credential and report it, rather than failing
 * on the way to finding out. Asking the store whether an id exists is the whole
 * check; the value never leaves the keychain.
 */
async function reportSecrets(values: Values): Promise<{ lines: string[]; allConfigured: boolean }> {
  const config = await loadWorkspaceConfig({
    ...(values.config !== undefined ? { configPath: values.config } : {}),
  });
  const names = secretsReferencedBy(config);
  if (names.length === 0) return { lines: [], allConfigured: true };

  const opened = await tryOpenSecretStore({ namespace: namespaceOf(config) });
  if (!opened.store) {
    return {
      lines: [
        `  secrets   ${names.length} referenced, and no secret store is available`,
        `            ${opened.reason}`,
      ],
      allConfigured: false,
    };
  }
  const lines: string[] = [];
  let allConfigured = true;
  for (const name of names) {
    const id = secretIdFor(name, DEFAULT_CONTEXT);
    // `has`, not `get`: reading the value is what raises the macOS permission
    // dialog and what blocks on a locked keychain, and this command's whole
    // job is to work when something is wrong.
    const present = await opened.store.has(id);
    if (!present) allConfigured = false;
    lines.push(
      `  ${lines.length === 0 ? 'secrets ' : '        '}  ${present ? '\u2713' : '\u2717'} ${name}` +
        (present ? '' : ` \u2014 not configured; \`tuplescope secret set ${id}\``),
    );
  }
  return { lines, allConfigured };
}

async function commandStatus(values: Values): Promise<number> {
  // Before the workspace opens, because opening it resolves secrets and a
  // missing one would abort the very report that explains why.
  let secretsOk = true;
  let secretLines: string[] = [];
  try {
    const report = await reportSecrets(values);
    secretLines = report.lines;
    secretsOk = report.allConfigured;
  } catch (error) {
    if (!(error instanceof WorkspaceConfigError)) throw error;
  }
  if (!secretsOk) {
    // The workspace cannot open without them, so this is the whole report.
    process.stdout.write('tuplescope\n');
    for (const line of secretLines) process.stdout.write(`${line}\n`);
    return 2;
  }

  const result = await withWorkspace(values, async (session) => {
    const style = styleFor(values);
    process.stdout.write(`${renderWorkspaceLine(style, session.config)}\n`);
    for (const line of secretLines) process.stdout.write(`${line}\n`);
    try {
      const { tables, scope } = await session.preflight();
      process.stdout.write(
        `  database  reachable · ${tables.length} tables in \`${scope.schema}\`\n`,
      );
      for (const line of renderScope(style, scope)) process.stdout.write(`${line}\n`);
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

// ─── show / check / runs ──────────────────────────────────────────────────────

async function commandShow(targets: string[], values: Values): Promise<number> {
  if (targets.length !== 1) {
    process.stderr.write('show needs exactly one target: scenario[/dataset].\n');
    return EXIT_USAGE;
  }
  const result = await withWorkspace(values, async (session) => {
    const loaded = await session.scenarios();
    const selected = select(loaded, targets, values.dataset);
    if (typeof selected === 'string') {
      process.stderr.write(`${selected}\n`);
      return EXIT_USAGE;
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const { scenario, dataset, file } of selected) {
      if (!seen.has(scenario.id)) {
        seen.add(scenario.id);
        out.push('', `${scenario.id}  ${scenario.title}`, `  file   ${file}`);
        if (scenario.why) out.push(`  why    ${scenario.why.trim().replace(/\n\s*/g, ' ')}`);
        out.push(
          `  watch  ${
            scenario.watch?.length
              ? scenario.watch.map((w) => w.table + (w.where ? ` where ${w.where}` : '')).join(', ')
              : 'every table (nothing declared, which is the better default)'
          }`,
        );
        if (scenario.ignoreColumns?.length) out.push(`  ignore ${scenario.ignoreColumns.join(', ')}`);
      }
      out.push('', `  ${scenario.id}/${dataset.id}  ${dataset.label}`);
      if (dataset.note) out.push(`    ${dataset.note}`);
      if (dataset.resetFirst) out.push('    resets the database first');
      for (const step of dataset.steps) {
        const expects = step.expectStatus !== undefined ? `  expects ${step.expectStatus}` : '';
        out.push(`    ${step.id.padEnd(18)} ${step.request.method} ${step.request.path}${expects}`);
        for (const assertion of step.assert ?? []) out.push(`      ${assertion}`);
        if ((step.assert ?? []).length === 0) out.push('      (checks nothing)');
      }
    }
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  });
  return typeof result === 'number' ? result : 0;
}

/**
 * What this suite can prove, without touching the backend.
 *
 * The point is to surface a hole before CI does: a table an assertion names
 * that the database does not have, a step that checks nothing. A scenario can
 * be perfectly valid YAML and still establish nothing.
 */
async function commandCheck(targets: string[], values: Values): Promise<number> {
  const result = await withWorkspace(values, async (session) => {
    const loaded = await session.scenarios();
    const selected = select(loaded, targets, values.dataset);
    if (typeof selected === 'string') {
      process.stderr.write(`${selected}\n`);
      return EXIT_USAGE;
    }
    let tables: string[];
    let columns: Map<string, Set<string>>;
    let scope: { schema: string; watched: number; otherSchemas: ReadonlyArray<{ schema: string; tables: number }>; nameFiltered: ReadonlyArray<string>; partitionedParents: ReadonlyArray<string>; foreignTables: ReadonlyArray<string> };
    try {
      ({ tables, columns, scope } = await session.preflight());
    } catch (error) {
      const workspaceError = error instanceof WorkspaceError ? error : undefined;
      process.stderr.write(`${workspaceError?.message ?? String(error)}\n`);
      if (workspaceError?.remedy) process.stderr.write(`${workspaceError.remedy}\n`);
      return 2;
    }

    const known = new Set(tables);
    const problems: string[] = [];
    let assertions = 0;
    let unchecked = 0;

    for (const { scenario, dataset } of selected) {
      for (const step of dataset.steps) {
        const list = step.assert ?? [];
        assertions += list.length;
        if (list.length === 0) {
          unchecked++;
          problems.push(
            `  ${scenario.id}/${dataset.id}/${step.id}  checks nothing — it will be observed and verified by no one`,
          );
        }
        // No check here for "a negative assertion with no declared status": the
        // engine now treats a missing expectStatus as "a success is expected",
        // so a 4xx fails the step outright. Repeating it here only produced a
        // false positive on every step that declared its status as an
        // assertion rather than as expectStatus, which is the commoner spelling.
        for (const assertion of list) {
          const missing = tablesNamedIn(assertion).filter((t) => !known.has(t));
          for (const table of missing) {
            problems.push(
              `  ${scenario.id}/${dataset.id}/${step.id}  names table \`${table}\`, which is not in this database`,
            );
          }
          // The columns inside a predicate, which the evaluator resolves only
          // when it has a row to resolve them against. On a step that writes
          // nothing it never gets one, so `count(inserted(t).where(nmae = "x"))
          // == 0` is green for as long as the typo lives — and that is the
          // shape of a "must not write twice" guard, the assertion this tool
          // exists to make. Here is the one place with a connection and no
          // rows to depend on.
          let named: Array<{ table: string; column: string }>;
          try {
            named = predicateColumnsIn(parse(assertion));
          } catch {
            // Unparseable: `run` will say so in its own words, with position.
            named = [];
          }
          for (const { table, column } of named) {
            const have = columns.get(table);
            // An unknown table is already reported above; do not say it twice.
            if (!have || have.has(column)) continue;
            problems.push(
              `  ${scenario.id}/${dataset.id}/${step.id}  matches on \`${table}.${column}\`, ` +
                `which is not a column of \`${table}\``,
            );
          }
        }
      }
    }

    const out = [
      `tuplescope · ${session.config.name}`,
      `  selected   ${selected.length} dataset(s), ${assertions} assertion(s)`,
      `  database   ${tables.length} tables in \`${scope.schema}\``,
      // The boundary belongs here more than anywhere: `check` is what a reader
      // runs before trusting a suite, and a table outside the scope is a
      // question this suite will answer wrongly and silently.
      ...renderScope(styleFor(values), scope, '             '),
    ];
    if (problems.length > 0) {
      out.push('', ...problems);
    } else if (assertions === 0) {
      // Nothing to be right about. This command is what the README puts in
      // front of the pipeline, and its clean sentence is an unconditional
      // assurance — so a workspace that asserts nothing must not receive it.
      // `run` already refuses the same shape; `check` said the words and
      // exited 0, on a suite where the answer had not been looked for.
      out.push(
        '',
        selected.length === 0
          ? '  Nothing was selected, so nothing was checked.'
          : `  ${selected.length} dataset(s) selected, and not one assertion between them.`,
        '  A green `check` over nothing asserted is the failure this command exists to prevent.',
      );
    } else {
      out.push('', '  Nothing here would fail for a reason other than the system under test.');
    }
    process.stdout.write(`${out.join('\n')}\n`);
    // Exit 3: the suite is not wrong, it just does not establish what it looks
    // like it does — the same meaning the code has everywhere else.
    return problems.length > 0 || assertions === 0 ? 3 : 0;
  });
  return typeof result === 'number' ? result : 0;
}

const RESERVED = new Set([
  'response', 'status', 'body', 'headers', 'count', 'single', 'sum', 'min', 'max',
  'any', 'all', 'inserted', 'updated', 'deleted', 'changes', 'rows', 'hasWrite',
  'isEmpty', 'before', 'after', 'delta', 'where', 'true', 'false', 'null', 'and', 'or', 'not',
]);

/** Table names are the identifiers in a selector's first argument position. */
function tablesNamedIn(source: string): string[] {
  return [...source.matchAll(/\b(?:changes|inserted|updated|deleted|rows)\(\s*([A-Za-z_][A-Za-z0-9_]*)/g)]
    .map((m) => m[1]!)
    .filter((name) => !RESERVED.has(name));
}

async function commandRuns(args: string[], values: Values): Promise<number> {
  const result = await withWorkspace(values, async (session) => {
    const store = session.history;
    if (!store) {
      process.stderr.write('Run history is off for this invocation.\n');
      return EXIT_USAGE;
    }
    if (args[0] === 'show') {
      const id = args[1];
      if (!id) {
        process.stderr.write('runs show needs a run id, or `last`.\n');
        return EXIT_USAGE;
      }
      const stored = id === 'last' ? await store.latest() : await store.get(id);
      if (!stored) {
        process.stderr.write(`No stored run \`${id}\`. \`tuplescope runs\` lists what is there.\n`);
        return EXIT_USAGE;
      }
      process.stdout.write(`${JSON.stringify(stored, null, 2)}\n`);
      return 0;
    }

    const limit = Number(args[0] ?? 20) || 20;
    const rows = await store.list(limit);
    if (rows.length === 0) {
      process.stdout.write(`No stored runs yet. They land in ${store.dir} as runs happen.\n`);
      return 0;
    }
    const out = rows.map(
      (row) =>
        `  ${row.id.padEnd(16)} ${row.outcome.padEnd(10)} ${`${row.scenarioId}/${row.datasetId}`.padEnd(28)}` +
        `${row.coverage === 'partial' ? 'partial  ' : '         '}${row.startedAt}`,
    );
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  });
  return typeof result === 'number' ? result : 0;
}

// ─── keep ─────────────────────────────────────────────────────────────────────

/**
 * Turns what a run observed into assertions in the scenario file.
 *
 * This is the loop the product exists for. The honest answer to "why not write
 * pytest and a few SQL assertions" is that a hand-written test is more precise
 * — its only weakness is that you have to know the answer before you write it.
 * Running first and keeping what you saw is the part a test file cannot do.
 *
 * It reads a *stored* run rather than only the one still in memory: promoting
 * would otherwise only work if you noticed in the same breath as the run.
 */
async function commandKeep(args: string[], values: Values): Promise<number> {
  const [selector, stepId, ...picked] = args;
  if (!selector || !stepId) {
    process.stderr.write('keep needs a target and a step: tuplescope keep refund/happy create_payment\n');
    return EXIT_USAGE;
  }
  const [scenarioId, datasetId] = selector.split('/');

  const result = await withWorkspace(values, async (session) => {
    if (!session.history) {
      process.stderr.write('Run history is off, so there is no run to keep anything from.\n');
      return EXIT_USAGE;
    }
    const source = values['continue-from'] ?? 'last';
    const stored =
      source === 'last'
        ? await session.history.latest({
            ...(scenarioId ? { scenarioId } : {}),
            ...(datasetId ? { datasetId } : {}),
          })
        : await session.history.get(source);
    if (!stored) {
      process.stderr.write(
        `No stored run for \`${selector}\`. Run it once, then keep what it showed you.\n`,
      );
      return EXIT_USAGE;
    }

    const steps = (stored['steps'] ?? []) as Array<{
      id: string;
      candidates?: Array<{ expression: string; description: string; caveat?: { message: string } }>;
    }>;
    const step = steps.find((entry) => entry.id === stepId);
    if (!step) {
      process.stderr.write(
        `Run \`${stored.run.id}\` has no step \`${stepId}\`. It has: ${steps.map((x) => x.id).join(', ')}.\n`,
      );
      return EXIT_USAGE;
    }
    const candidates = step.candidates ?? [];
    if (candidates.length === 0) {
      process.stdout.write(`Step \`${stepId}\` changed nothing that suggests an assertion.\n`);
      return 0;
    }

    const loaded = await session.scenarios();
    const found = loaded.find((entry) => entry.scenario.id === (scenarioId ?? stored.run.scenarioId));
    if (!found) {
      process.stderr.write(`No scenario \`${scenarioId}\` on disk any more.\n`);
      return EXIT_USAGE;
    }
    const targetDataset = datasetId ?? String(stored.run.datasetId);
    const existing = new Set(
      found.scenario.datasets
        .find((d) => d.id === targetDataset)
        ?.steps.find((x) => x.id === stepId)?.assert ?? [],
    );

    if (picked.length === 0) {
      const out = candidates.map((candidate, index) => {
        const kept = existing.has(candidate.expression) ? '  (already kept)' : '';
        return (
          `  ${String(index + 1).padStart(2)}  ${candidate.expression}${kept}\n` +
          `      ${candidate.description}` +
          (candidate.caveat ? `\n      caveat: ${candidate.caveat.message}` : '')
        );
      });
      process.stdout.write(
        `${found.scenario.id}/${targetDataset}/${stepId}  ·  from run ${stored.run.id}\n\n` +
          `${out.join('\n')}\n\n` +
          `  tuplescope keep ${selector} ${stepId} 1 2   keeps those two\n`,
      );
      return 0;
    }

    let added = 0;
    for (const raw of picked) {
      const index = Number(raw);
      const candidate = candidates[index - 1];
      if (!Number.isInteger(index) || !candidate) {
        process.stderr.write(`\`${raw}\` is not one of the 1–${candidates.length} listed.\n`);
        return EXIT_USAGE;
      }
      try {
        const result = await addAssertion({
          file: found.file,
          datasetId: targetDataset,
          stepId,
          expression: candidate.expression,
        });
        process.stdout.write(
          `  ${result.added ? 'kept' : 'already there'}  ${candidate.expression}\n`,
        );
        if (result.added) added++;
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        return EXIT_USAGE;
      }
    }
    if (added > 0) {
      process.stdout.write(`\n  ${found.file}\n  Run it again and the next regression is caught.\n`);
    }
    return 0;
  });
  return typeof result === 'number' ? result : 0;
}

// ─── report ───────────────────────────────────────────────────────────────────

/**
 * Re-renders stored envelopes without re-running anything.
 *
 * The use it exists for: a CI job wrote JSON, and somebody wants the JUnit it
 * did not ask for, or wants several shards merged into one verdict — neither
 * of which should mean touching the database again.
 */
async function commandReport(files: string[], values: Values): Promise<number> {
  if (files.length === 0) {
    process.stderr.write('report needs at least one stored envelope: tuplescope report run.json\n');
    return EXIT_USAGE;
  }
  const { readFile } = await import('node:fs/promises');
  const envelopes: Envelope[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Envelope;
      if (typeof parsed.schema !== 'string' || !parsed.schema.startsWith('tuplescope.run-report/')) {
        process.stderr.write(`${file}: not a TupleScope run report.\n`);
        return EXIT_USAGE;
      }
      const major = Number(parsed.schema.split('/')[1]);
      const supported = Number(RUN_REPORT_SCHEMA.split('/')[1]);
      if (!Number.isInteger(major)) {
        process.stderr.write(`${file}: unreadable schema version \`${parsed.schema}\`.\n`);
        return EXIT_USAGE;
      }
      if (major > supported) {
        // A newer producer. Refusing beats guessing: the rule everywhere else
        // is that an unknown value degrades to undecided, and silently reading
        // a format we do not know would be the opposite of that.
        process.stderr.write(
          `${file}: written by a newer TupleScope (${parsed.schema}); this build reads version ${supported}.\n`,
        );
        return EXIT_USAGE;
      }
      if (major < supported) {
        // The gate only ever looked upwards, so an *older* file sailed through
        // and was rendered as though its fields meant what they mean now. A
        // /1 file's column values carry `text` with no `state`, which reads as
        // neither visible nor masked — every value would print as unknown.
        process.stderr.write(
          `${file}: written by an older TupleScope (${parsed.schema}); this build reads version ${supported}. ` +
            `Re-run the scenario to produce a current report.\n`,
        );
        return EXIT_USAGE;
      }
      envelopes.push(parsed);
    } catch (error) {
      process.stderr.write(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_USAGE;
    }
  }

  const merged: Envelope = {
    ...envelopes[0]!,
    runs: envelopes.flatMap((e) => e.runs),
    // The worst outcome across every file, by the same precedence a suite uses.
    outcome: (['errored', 'failed', 'undecided', 'clean'] as const).find((outcome) =>
      envelopes.some((e) => e.outcome === outcome),
    )!,
    exitCode: Math.max(...envelopes.map((e) => e.exitCode)),
    proves: envelopes.some((e) => e.proves === 'bounded') ? 'bounded' : 'full',
    boundedBy: [...new Set(envelopes.flatMap((e) => e.boundedBy))],
  };

  if (values.junit !== undefined) {
    const xml = toJUnit(merged);
    if (values.junit === '-') process.stdout.write(xml);
    else writeFileSync(values.junit, xml, 'utf8');
  }
  if (values.json) process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
  if (!values.json && values.junit === undefined) {
    const lines = [
      `${merged.runs.length} run(s) from ${files.length} file(s)`,
      `  outcome  ${merged.outcome}`,
      `  exit     ${merged.exitCode}`,
    ];
    for (const report of merged.runs) {
      lines.push(
        `  ${report.selector.padEnd(28)} ${report.verdict.outcome.padEnd(10)} ` +
          `${report.verdict.assertions.passed}/${report.verdict.assertions.total} passed`,
      );
    }
    if (merged.proves === 'bounded') {
      lines.push('', '  bounded by:');
      for (const bound of merged.boundedBy) lines.push(`    · ${bound}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return merged.exitCode;
}

// ─── run ──────────────────────────────────────────────────────────────────────

async function commandRun(targets: string[], values: Values, argv: string[]): Promise<number> {
  const policy = policyFrom(values);
  if (typeof policy === 'string') {
    process.stderr.write(`${policy}\n`);
    return EXIT_USAGE;
  }
  const partial = (values.from ?? values.only) !== undefined;
  if (partial && targets.length !== 1) {
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
      // A partial run continues a previous one, so it needs that run's whole
      // variable context — `{{run}}` included. Pairing an old payment id with
      // a fresh suffix is not a replay of anything: the idempotency key would
      // not match, and a step written to send a duplicate sends a new request.
      let carried: Readonly<Record<string, string>> | undefined;
      if (partial) {
        const source = values['continue-from'] ?? 'last';
        const stored =
          source === 'last'
            ? await session.history?.latest({
                scenarioId: scenario.id,
                datasetId: dataset.id,
                coverage: 'full',
              })
            : await session.history?.get(source);
        if (!stored) {
          process.stderr.write(
            source === 'last'
              ? `--from/--only continue a previous run, and there is no stored full run of ` +
                `\`${scenario.id}/${dataset.id}\` to continue. Run the whole dataset once first.\n`
              : `No stored run \`${source}\`. \`tuplescope runs\` lists what is there.\n`,
          );
          return EXIT_USAGE;
        }
        const variables = (stored.run as { variables?: Record<string, string> }).variables;
        if (!variables) {
          process.stderr.write(`Stored run \`${stored.run.id}\` recorded no variables.\n`);
          return EXIT_USAGE;
        }
        carried = variables;
        process.stderr.write(
          `carrying variables from ${stored.run.id} (${stored.run.startedAt ?? 'unknown time'})\n`,
        );
      }

      let run;
      try {
        run = await session.engine.run(scenario, dataset.id, scope, {
          ...(values.from !== undefined ? { fromStepId: values.from } : {}),
          ...(values.only !== undefined ? { onlyStepId: values.only } : {}),
          ...(carried ? { variables: carried } : {}),
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
      producer: { tool: 'tuplescope', version: VERSION, surface: 'cli' },
      workspace: {
        name: session.config.name,
        configPath: session.config.configFile,
        baseUrl: session.config.baseUrl,
        scenariosDir: session.config.scenariosDir,
        capture: {
          method: session.adapter.captureMethod,
          detection: session.adapter.detection,
          fidelity: session.adapter.fidelity,
        },
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

    if (session.history) {
      for (const single of envelope.runs) {
        // Stored as a one-run envelope rather than a second on-disk schema:
        // it already carries the policy, the producer and the exit code.
        await session.history.save({
          ...single,
          run: { ...single.run, scenarioId: single.scenario.id, datasetId: single.dataset.id },
          schema: envelope.schema,
          producer: envelope.producer,
          workspace: envelope.workspace,
          policy: envelope.policy,
        } as never);
      }
    }

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

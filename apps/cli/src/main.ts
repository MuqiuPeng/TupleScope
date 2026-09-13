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
import {
  DEFAULT_POLICY,
  exitCodeOf,
  mergeVerdicts,
  verdictOf,
  type RunVerdict,
  type VerdictPolicy,
} from '@tuplescope/core';
import {
  RUN_REPORT_SCHEMA,
  buildEnvelope,
  envelopeOfStoredRun,
  isStoredRun,
  mergeEnvelopes,
  toJUnit,
  type Envelope,
} from '@tuplescope/report';
import {
  StaleRunError,
  WorkspaceConfigError,
  WorkspaceError,
  loadWorkspace,
  loadWorkspaceConfig,
  namespaceOf,
  openWorkspace,
  probeBackend,
  secretsReferencedBy,
  type Reachability,
  type ResolvedWorkspaceConfig,
} from '@tuplescope/workspace';
import {
  addAssertion,
  auditScenarios,
  formatProblem,
  ScenarioLoadError,
} from '@tuplescope/scenario-engine';
import { listSessions } from './sessions.js';
import {
  renderRun,
  renderWorkspaceLine,
  renderScope,
  styleFor,
  unresolvedFilterColumns,
  type ScopeReport,
} from './output.js';
import { panelProblems } from './panels.js';
import { dash, dot, glyph, type Style } from './render.js';
import { asciiDocument, installAsciiOutput, installScrubber, scrubbed } from './scrub.js';
import { ignoreClosedPipes } from './pipes.js';
import { baselineOverride, baselineWindowFor } from './baseline.js';
import { junitTargetProblem, writeJUnitFile } from './junit-file.js';
import { attributingStore, SecretUnreadable } from './store-read.js';
import {
  DEFAULT_CONTEXT,
  SecretNotConfigured,
  secretIdFor,
  SecretStoreUnavailable,
  tryOpenSecretStore,
} from '@tuplescope/secrets';
import { commandHandoff, HANDOFF_USAGE } from './handoff.js';
import { commandSecret, SECRET_USAGE } from './secrets.js';

/** One place, so `--version` and the envelope's `producer` cannot drift apart. */
const VERSION = '0.4.0';

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
  all: { type: 'boolean' },
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
      --config <path>          the workspace file to use, instead of searching upward
      --no-save                do not record this run in .tuplescope/runs
      --unevaluable <mode>     error | warn        whether an undecided check
                               reaches the exit code                 (error)
      --warnings <mode>        default | strict | off                (default)
      --require-assertions     a run that checked nothing exits 3
      --baseline <ms|off>      idle window watched before the run
      --pass-with-no-scenarios exit 0 when nothing was selected — for a pipeline
                               wired up before the first scenario exists
      --exit-zero              cap outcomes 1 and 3 at 0; never masks 2, 4, 5

Output
      --json                   the machine envelope on stdout
      --junit <path>           JUnit XML; - for stdout, which --json also uses
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
  // Both before the first byte is written, so they cover every line after it,
  // the usage text a bad flag prints included (`pipes.ts`, `ascii.ts`).
  ignoreClosedPipes();
  if (argv.includes('--ascii')) installAsciiOutput();

  // The return type depends on `allowPositionals`, so it has to be part of the
  // annotation or `positionals` infers as the empty tuple.
  type Parsed = ReturnType<
    typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
  >;
  let parsed: Parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    // The usage of the command being typed, when it has one of its own. `secret
    // set --value x` is refused, rightly, and the refusal printed the global
    // help — fifteen commands, and not the line saying the value is read from
    // the terminal or a pipe.
    const attempted = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: false })
      .positionals[0];
    const usage = (attempted !== undefined ? SUBCOMMAND_USAGE.get(attempted) : undefined) ?? HELP;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
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
  // A command with a surface of its own prints that surface. `--help` was
  // answered here, before dispatch, with the global text — so `handoff --help`
  // listed fifteen commands and not one of list, enable or disable, while the
  // README called `--help` the full surface.
  const own = command !== undefined ? SUBCOMMAND_USAGE.get(command) : undefined;
  if (values.help && own) {
    process.stdout.write(own);
    return 0;
  }
  if (!command || command === 'help' || values.help) {
    process.stdout.write(HELP);
    // Asking for help and receiving it is not a usage error. `run --help`
    // printed the whole help text and then exited 4, so a script that checked
    // the status of its own `--help` probe concluded the command was wrong.
    return 0;
  }

  switch (command) {
    case 'url':
      return commandUrl(values.all === true);
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

/**
 * `all` comes from the parsed flags. It used to be looked for among the
 * positionals, where `--all` never is — `parseArgs` knows it as an option — so
 * the flag did nothing while the hint below told people to pass it.
 */
function commandUrl(all: boolean): number {
  const sessions = listSessions();
  if (sessions.length === 0) {
    process.stderr.write(
      'No TupleScope runtime is running.\nStart one with `pnpm start`; it prints its URL and records it for next time.\n',
    );
    return 1;
  }
  if (all) {
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
  // Validated here with its siblings rather than at the point of use, where
  // `Number('abc')` produced NaN, the probe was skipped, and the run exited 0 —
  // a flag whose whole job is detecting concurrent writes, silently doing
  // nothing. The two flags either side of it in HELP both refuse and exit 4.
  const baseline = values.baseline;
  if (baseline !== undefined && baseline !== 'off') {
    const ms = Number(baseline);
    if (!Number.isFinite(ms) || ms < 0) {
      return `--baseline must be a number of milliseconds or \`off\`, not \`${baseline}\``;
    }
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
 * was built by someone else. This is the backstop. Once a workspace has opened
 * it is applied to both streams (see `scrub.ts`); this is for text on its way
 * somewhere else.
 */
export function scrubSecrets(text: string): string {
  return scrubbed(text);
}

/** The commands whose `--help` is their own usage rather than the global one. */
const SUBCOMMAND_USAGE: ReadonlyMap<string, string> = new Map([
  ['handoff', HANDOFF_USAGE],
  ['secret', SECRET_USAGE],
]);

async function withWorkspace<T>(
  values: Values,
  body: (session: Awaited<ReturnType<typeof open>>) => Promise<T>,
  /** For `status`, which marks the unreadable secret in its table instead. */
  onUnreadable?: (error: SecretUnreadable) => Promise<number>,
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
    // Stored, but not readable — an item this tool did not write, a locked
    // keychain. The store's sentence says what to do; it reached the user as
    // a stack trace and exit 2 from `ls`, `check` and `status`.
    if (error instanceof SecretUnreadable) {
      if (onUnreadable) return onUnreadable(error);
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
  // The workspace names credentials; this is where they become values. The
  // same door the runtime and MCP use — it lived here alone once, and they
  // each skipped the step.
  const { config, scrub } = await loadWorkspace({
    ...(values.config !== undefined ? { configPath: values.config } : {}),
    // The platform store, with a failed read carrying the secret it was for.
    openStore: attributingStore,
  });
  // Anything written from here on has the values taken back out — at the
  // streams, because a print site that had to remember to ask is how `status`
  // and `check` came to print a driver's message with the value in it.
  installScrubber(scrub);

  // The same reading of the flag the envelope's policy block reports (`baseline.ts`).
  const baseline = baselineOverride(values.baseline);
  return openWorkspace(config, {
    ...(baseline !== undefined ? { baselineWindowMs: baseline } : {}),
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
interface SecretsReport {
  config: ResolvedWorkspaceConfig;
  /** One per referenced secret; absent when there is no store to ask. */
  entries?: Array<{ name: string; id: string; present: boolean }>;
  unavailable?: { count: number; reason: string };
}

async function reportSecrets(values: Values): Promise<SecretsReport> {
  const config = await loadWorkspaceConfig({
    ...(values.config !== undefined ? { configPath: values.config } : {}),
  });
  const names = secretsReferencedBy(config);
  if (names.length === 0) return { config, entries: [] };

  const opened = await tryOpenSecretStore({ namespace: namespaceOf(config) });
  if (!opened.store) return { config, unavailable: { count: names.length, reason: opened.reason } };
  const entries: NonNullable<SecretsReport['entries']> = [];
  for (const name of names) {
    const id = secretIdFor(name, DEFAULT_CONTEXT);
    // `has`, not `get`: reading the value is what raises the macOS permission
    // dialog and what blocks on a locked keychain, and this command's whole
    // job is to work when something is wrong.
    entries.push({ name, id, present: await opened.store.has(id) });
  }
  return { config, entries };
}

/**
 * The secrets block of `status`.
 *
 * `unreadable` is a secret the store has and could not hand back. `has` cannot
 * see that — it never decrypts — so it is only known once opening the
 * workspace tried to read it, and its line then carries the store's reason.
 */
function renderSecrets(style: Style, report: SecretsReport, unreadable?: SecretUnreadable): string[] {
  if (report.unavailable) {
    return [
      `  secrets   ${report.unavailable.count} referenced, and no secret store is available`,
      `            ${report.unavailable.reason}`,
    ];
  }
  const entries = report.entries ?? [];
  const lines = entries.map(({ name, id, present }, index) => {
    const lead = `  ${index === 0 ? 'secrets ' : '        '}  `;
    if (unreadable?.id === id) {
      return `${lead}${glyph(style, 'fail')} ${name} ${dash(style)} ${unreadable.reason}`;
    }
    return present
      ? `${lead}${glyph(style, 'pass')} ${name}`
      : `${lead}${glyph(style, 'fail')} ${name} ${dash(style)} not configured; \`tuplescope secret set ${id}\``;
  });
  if (unreadable && !entries.some((entry) => entry.id === unreadable.id)) {
    lines.push(`  secrets   ${glyph(style, 'fail')} ${unreadable.id} ${dash(style)} ${unreadable.reason}`);
  }
  return lines;
}

/**
 * The third question. It needs nothing from the database or the secret store,
 * so it is asked whatever they answered.
 *
 * The asking is `probeBackend`'s and the wording is its `reason` and `remedy`;
 * what is left here is this surface's own layout — the label column, the
 * separators and their `--ascii` spelling. The fetch, the deadline and the
 * refusal to probe a `baseUrl` that still holds a marker used to live in this
 * function *and* in the runtime, which never probed at all and printed
 * `baseUrl` as if it had.
 *
 * `checkedAt` is not printed, and this is the one surface where leaving it out
 * is still honest: this line is written in the same event-loop turn as the
 * answer, by a process the reader started, so the invocation is the timestamp.
 * A page that keeps a rendered indicator on screen while its evidence ages has
 * no such alibi. If it is wanted here, it belongs on one line for the whole
 * report — beside `config`, where the database and the backend can share a
 * single moment — and that is a decision about `status`, not about this
 * function.
 */
async function reportBackend(style: Style, baseUrl: string): Promise<boolean> {
  // No `timeoutMs`: the module's default is the same 3s this passed explicitly,
  // and a second spelling of one deadline is a deadline that drifts.
  const backend = await probeBackend(baseUrl);
  process.stdout.write(`  backend   ${backendHeadline(style, backend)}\n`);
  // Whatever the value says to do, on the continuation line the unreachable
  // case already used. Not re-worded here: the CLI's own copy of the remedy is
  // how the terminal and the web page came to give different advice about the
  // same dead server.
  if (backend.remedy) process.stdout.write(`            ${backend.remedy}\n`);
  // `not-checked` counts as not answering, exactly as the `return false` under
  // the unresolved-secret branch did: nothing has proved the backend is there.
  // It is only the *exit code* that merges the two — the line above keeps them
  // apart, because "start your server" is the wrong errand for a reader whose
  // server is already running.
  return backend.state === 'reachable';
}

/** The `backend` line's own half, in the words this surface has always used. */
function backendHeadline(style: Style, backend: Reachability): string {
  switch (backend.state) {
    case 'reachable':
      // `status` is optional on the type; `probeBackend` sets it whenever
      // anything answered, and "answering" alone is still true without it.
      return backend.status === undefined
        ? 'answering'
        : `answering ${dot(style)} HTTP ${backend.status}`;
    case 'not-checked':
      return `not checked${backend.reason ? ` ${dash(style)} ${backend.reason}` : ''}`;
    case 'unreachable':
      // The reason is already a sentence naming the URL, so it carries the line
      // on its own — and it now ends in the driver's word for the failure.
      // Measured: a server that accepts the connection and never answers gave
      // the identical "nothing is listening at …" as a closed port, and sent
      // the reader to restart a process that was up the whole time. `:
      // ENOTFOUND` and `: it did not answer in time` are three more words for
      // two different errands. A refused connection carries no code of its own
      // (the driver raises an AggregateError there), so that line is unchanged.
      return backend.reason ?? 'not reachable';
  }
}

/**
 * Three questions, answered separately: whether the workspace resolved, whether
 * the database is reachable, whether the backend answers.
 *
 * Exit 4 when the workspace will not load — a file that does not parse, a
 * secret that is missing or cannot be read — which is what `ls`, `check` and
 * `show` already said about the same file while `status` said 2. Exit 2 when
 * it loads and the database or the backend does not answer.
 */
async function commandStatus(values: Values): Promise<number> {
  const style = styleFor(values);
  // Before the workspace opens, because opening it resolves secrets and a
  // missing one would abort the very report that explains why.
  let report: SecretsReport;
  try {
    report = await reportSecrets(values);
  } catch (error) {
    if (!(error instanceof WorkspaceConfigError)) throw error;
    // The message names the file and the key.
    process.stderr.write(`${scrubSecrets(error.message)}\n`);
    return EXIT_USAGE;
  }
  const known = report.config;

  // The workspace genuinely cannot open — `assertResolved` refuses any
  // surviving marker — so the database cannot be asked. What is *known* still
  // gets said: the workspace name and the config path are the two things a
  // reader needs to go and fix it. The backend is still asked; it used to be
  // "not checked, for the same reason", about a question that shares no reason
  // with the secrets.
  const cannotOpen = async (unreadable?: SecretUnreadable): Promise<number> => {
    process.stdout.write(`${renderWorkspaceLine(style, known)}\n`);
    for (const line of renderSecrets(style, report, unreadable)) process.stdout.write(`${line}\n`);
    process.stdout.write(
      `  database  not checked ${dash(style)} the workspace cannot open until every secret above resolves\n`,
    );
    await reportBackend(style, known.baseUrl);
    return EXIT_USAGE;
  };
  if (!report.entries || report.entries.some((entry) => !entry.present)) return cannotOpen();

  const result = await withWorkspace(
    values,
    async (session) => {
      process.stdout.write(`${renderWorkspaceLine(style, session.config)}\n`);
      for (const line of renderSecrets(style, report)) process.stdout.write(`${line}\n`);
      let reachable = true;
      try {
        const { tables, scope } = await session.preflight();
        process.stdout.write(
          `  database  reachable ${dot(style)} ${tables.length} tables in \`${scope.schema}\`\n`,
        );
        for (const line of renderScope(style, scope)) process.stdout.write(`${line}\n`);
      } catch (error) {
        // On stdout with the rest of the table: it went to stderr alone, so
        // `status > file` kept every answer except the one that was wrong.
        const message = error instanceof WorkspaceError ? error.message : String(error);
        const remedy = error instanceof WorkspaceError ? error.remedy : undefined;
        process.stdout.write(`  database  ${message}\n${remedy ? `            ${remedy}\n` : ''}`);
        reachable = false;
      }
      // Measured: with the database down and the backend answering 200, this
      // returned at the database line and the backend was never mentioned.
      const answering = await reportBackend(style, session.config.baseUrl);
      return reachable && answering ? 0 : 2;
    },
    cannotOpen,
  );
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
    // The same type `renderScope` takes. A copy of it written out here lagged
    // behind the adapter's report, and a field missing from it is one `check`
    // cannot print.
    let scope: ScopeReport;
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

    const everyColumn = new Set([...columns.values()].flatMap((set) => [...set]));
    problems.push(...unresolvedFilterColumns(session.config, everyColumn));

    // Panel sources are expressions in the same language, resolved against the
    // same schema — tables, predicate columns and value columns (`panels.ts`).
    problems.push(...panelProblems(session.config.panels ?? [], known, columns));

    // Which tables a run cannot see a row leave. A fact about the table and the
    // engine together — snapshot-diff sees a row leave a keyless table, the MVCC
    // engines do not — so it is read off the scope a run builds, not off the
    // identity report `status` prints.
    const keyless = new Set(
      (await session.adapter.fullScope()).tables
        .filter((table) => table.departuresObservable === false)
        .map((table) => table.table),
    );
    const audit = auditScenarios(selected, {
      tables: known,
      columns,
      // Asked by capability, never by engine name (packages/core/src/abstraction.test.ts).
      capture: { detection: session.adapter.detection, fidelity: session.adapter.fidelity },
      ...(session.config.maskColumns ? { maskColumns: session.config.maskColumns } : {}),
      keyless,
    });
    assertions = audit.assertions;
    problems.push(...audit.problems.map((p) => formatProblem(p, '  ')));

    const out = [
      `tuplescope ${dot(styleFor(values))} ${session.config.name}`,
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
      process.stdout.write(asciiDocument(`${JSON.stringify(stored, null, 2)}\n`, 'json'));
      return 0;
    }

    const asked = Number(args[0] ?? 20);
    const limit = Number.isInteger(asked) && asked > 0 ? asked : 20;
    // Every readable run, so the listing can say what it leaves out. It showed
    // the newest 20 of 50 and said nothing — measured on a workspace holding
    // 50 — which reads as "these are the runs". At most `keep` (50) files.
    const all = await store.list(Number.MAX_SAFE_INTEGER);
    const rows = all.slice(0, limit);
    // A file the store cannot read is skipped by `list`; counted here so the
    // total is not quietly smaller than the directory.
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(store.dir).catch(() => [] as string[])).filter((name) =>
      name.endsWith('.json'),
    ).length;
    const unreadable = Math.max(0, files - all.length);
    if (all.length === 0 && unreadable === 0) {
      process.stdout.write(`No stored runs yet. They land in ${store.dir} as runs happen.\n`);
      return 0;
    }
    const out = rows.map(
      (row) =>
        `  ${row.id.padEnd(16)} ${row.outcome.padEnd(10)} ${`${row.scenarioId}/${row.datasetId}`.padEnd(28)}` +
        `${row.coverage === 'partial' ? 'partial  ' : '         '}${row.startedAt}`,
    );
    if (rows.length < all.length) {
      out.push(
        '',
        `  the newest ${rows.length} of ${all.length} stored runs; \`tuplescope runs ${all.length}\` lists every one`,
      );
    }
    if (unreadable > 0) {
      out.push(
        ...(rows.length < all.length ? [] : ['']),
        `  ${unreadable} more file(s) in ${store.dir} could not be read by this build, and are not listed`,
      );
    }
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
/**
 * `--json` and `--junit -` both claim stdout.
 *
 * Accepted together they wrote one document after the other — measured,
 * `report shard.json --junit - --json` produced a file that is neither valid
 * XML nor valid JSON, with exit 1 and no warning. Refused before any work.
 */
function streamConflict(values: Values): string | undefined {
  return values.json && values.junit === '-'
    ? '--json and --junit - both write to stdout, and one after the other is neither valid ' +
        'JSON nor valid XML. Send the JUnit to a file: --junit <path>.'
    : undefined;
}

async function commandReport(files: string[], values: Values): Promise<number> {
  const conflict = streamConflict(values);
  if (conflict) {
    process.stderr.write(`${conflict}\n`);
    return EXIT_USAGE;
  }
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
      // A stored run (`.tuplescope/runs/*.json`) passes the schema gate — it
      // was saved as a one-run envelope with the header spread over the run —
      // but has no `runs` list. It went straight into the merge below, which
      // made a list of one `undefined`, and the crash named `.selector` rather
      // than the file. Wrap it instead: everything the merge needs is on it.
      if (isStoredRun(parsed)) {
        envelopes.push(envelopeOfStoredRun(parsed));
      } else if (Array.isArray(parsed.runs)) {
        envelopes.push(parsed);
      } else {
        process.stderr.write(`${file}: carries the report schema but neither runs nor a run.\n`);
        return EXIT_USAGE;
      }
    } catch (error) {
      process.stderr.write(`${file}: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_USAGE;
    }
  }

  // Totals, targets and warnings recomputed over every run; the exit code from
  // the merged outcome, so the two cannot disagree. See `merge.ts`.
  const merged: Envelope = mergeEnvelopes(envelopes);

  if (values.junit !== undefined) {
    const xml = toJUnit(merged);
    if (values.junit === '-') process.stdout.write(asciiDocument(xml, 'xml'));
    else {
      const problem = writeJUnitFile(values.junit, xml);
      if (problem) {
        process.stderr.write(`${problem}\n`);
        return EXIT_USAGE;
      }
    }
  }
  if (values.json) process.stdout.write(asciiDocument(`${JSON.stringify(merged, null, 2)}\n`, 'json'));
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
  const conflict = streamConflict(values);
  if (conflict) {
    process.stderr.write(`${conflict}\n`);
    return EXIT_USAGE;
  }
  const policy = policyFrom(values);
  if (typeof policy === 'string') {
    process.stderr.write(`${policy}\n`);
    return EXIT_USAGE;
  }
  // Before a single request: a report path that cannot be written was found
  // only after the whole suite had run against the database, as a stack trace.
  if (values.junit !== undefined) {
    const problem = junitTargetProblem(values.junit);
    if (problem) {
      process.stderr.write(`${problem}\n`);
      return EXIT_USAGE;
    }
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
        (values.junit === '-' ? process.stderr : process.stdout).write(
          `${renderRun(style, values, session.config, run, verdict).join('\n')}\n`,
        );
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
        // The window this invocation watched, not the workspace file's (`baseline.ts`).
        baselineWindowMs: baselineWindowFor(values.baseline, session.config.baselineWindowMs),
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

    // With `--junit -` stdout *is* the report, so everything meant for a person
    // moves to stderr. It used to share the stream with the XML, and the file
    // that came out was rejected by every parser — silently, exit 0, which
    // reads as "TupleScope produced no report" rather than "the report has a
    // run summary stapled to the front of it".
    const human = values.junit === '-' ? process.stderr : process.stdout;
    // Documents go out escaped under --ascii, never transliterated: a value in
    // the envelope must read back as the value the database held (`ascii.ts`).
    if (values.json) process.stdout.write(asciiDocument(`${JSON.stringify(envelope, null, 2)}\n`, 'json'));
    let unwritten: string | undefined;
    if (values.junit !== undefined) {
      const xml = toJUnit(envelope);
      if (values.junit === '-') process.stdout.write(asciiDocument(xml, 'xml'));
      // Written synchronously: a report the exit code refers to must exist
      // before the process leaves, even on a signal.
      else unwritten = writeJUnitFile(values.junit, xml);
    }
    // `--quiet` means the summary alone, not silence: the outcome line is the
    // one thing a human always needs, and suppressing it made the flag useless.
    if (!values.json) {
      const { renderSummary } = await import('./render.js');
      human.write(`${renderSummary(styleFor(values), suite as RunVerdict, exitCode).join('\n')}\n`);
    }
    // Checked before the run, so this is a path that changed underneath it.
    // The report the exit code would describe does not exist, so the exit
    // code cannot be the run's.
    if (unwritten) {
      process.stderr.write(`${unwritten}\n`);
      return EXIT_USAGE;
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

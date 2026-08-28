/**
 * Runs a dataset: sequence the steps, thread the variables, observe the
 * database around each request, and score the assertions.
 *
 * The engine is headless. The web UI, the CLI and eventually MCP are all
 * callers of this, never the other way round — a UI that owns the business
 * logic is a UI the other three can't be built behind.
 */

import {
  parse as parseExpr,
  evaluateAssertion,
  predicateClauses,
  rowsSelectorsIn,
  Unevaluable,
  ExprSyntaxError,
} from '@statescope/expr';
import { HttpRunner, HttpRunnerError } from '@statescope/http-runner';
import { promoteCandidates } from './promote.js';
import { ValueUnavailable } from '@statescope/core';
import type {
  AssertionResult,
  CaptureScope,
  ChangeSet,
  DatabaseAdapter,
  Dataset,
  RowsRead,
  Run,
  Scenario,
  Selector,
  Step,
  StepResult,
} from '@statescope/core';

export interface EngineOptions {
  adapter: DatabaseAdapter;
  runner: HttpRunner;
  /** Wipes and reseeds. Required only by datasets that declare `resetFirst`. */
  reset?: () => Promise<void>;
  /**
   * Length of the idle observation taken before the first step. Zero disables
   * it. Anything it finds means something other than this scenario writes here.
   */
  baselineWindowMs?: number;
  now?: () => Date;
}

export interface RunOptions {
  /**
   * Start here instead of at the first step ("run from here"), or run this one
   * step alone. Both need variables from an earlier run — see `variables`.
   */
  fromStepId?: string;
  onlyStepId?: string;
  /**
   * Values captured by a previous run, so a partial run can resolve
   * placeholders its own steps never captured.
   */
  variables?: Readonly<Record<string, string>>;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  type: 'run-started' | 'step-started' | 'step-finished' | 'run-finished';
  run: Run;
  step?: StepResult;
}

/**
 * The rows a step's selectors asked for, and why any of them was refused.
 *
 * Both halves, because a refusal used to become the same generic "could not be
 * read" whatever caused it. A predicate over a masked column is fixed by
 * editing `maskColumns`, and a message that does not say so leaves the reader
 * with nothing to act on.
 */
interface CurrentRows {
  rows: Map<string, RowsRead>;
  refusals: Map<string, string>;
}

export class ScenarioEngine {
  constructor(private readonly options: EngineOptions) {}

  async run(
    scenario: Scenario,
    datasetId: string,
    scope: CaptureScope,
    options: RunOptions = {},
  ): Promise<Run> {
    const onProgress = options.onProgress;
    const dataset = scenario.datasets.find((d) => d.id === datasetId);
    if (!dataset) {
      throw new Error(
        `Scenario \`${scenario.id}\` has no dataset \`${datasetId}\`. ` +
          `Available: ${scenario.datasets.map((d) => d.id).join(', ')}.`,
      );
    }

    const now = this.options.now ?? (() => new Date());
    const run: Run = {
      id: `run_${now().getTime().toString(36)}`,
      scenarioId: scenario.id,
      datasetId: dataset.id,
      startedAt: now().toISOString(),
      status: 'running',
      coverage: options.fromStepId || options.onlyStepId ? 'partial' : 'full',
      // Filled in below. Recorded even when the probe is disabled, because
      // "not probed" is a fact a verdict has to be able to state.
      baseline: { probed: false, windowMs: 0 },
      steps: [],
      variables: builtins(now, options),
    };
    onProgress?.({ type: 'run-started', run });

    // A partial run deliberately builds on what the previous run left behind,
    // so resetting would destroy the very state it needs.
    if (dataset.resetFirst && run.coverage === 'full') {
      if (!this.options.reset) {
        throw new Error(
          `Dataset \`${dataset.id}\` declares resetFirst, but this workspace has no reset command.`,
        );
      }
      await this.options.reset();
    }

    const baselineWindowMs = this.options.baselineWindowMs ?? 0;
    const mutable = run as { -readonly [K in keyof Run]: Run[K] };
    mutable.baseline = { probed: baselineWindowMs > 0, windowMs: baselineWindowMs };
    if (baselineWindowMs > 0) {
      const noise = await this.options.adapter.probeBaselineNoise(scope, baselineWindowMs);
      // Kept whenever the probe found anything at all, including warnings with
      // no rows — an empty `changes` with a non-empty `warnings` still bounds
      // what the run proves.
      if (noise.changes.length > 0 || noise.warnings.length > 0) mutable.baselineNoise = noise;
    }

    const steps: StepResult[] = [];
    mutable.steps = steps;

    for (const step of selectSteps(dataset, options)) {
      const result = await this.runStep(step, scope, mutable, now);
      steps.push(result);
      onProgress?.({ type: 'step-finished', run, step: result });

      // Later steps depend on what earlier ones captured, so a hard failure ends
      // the dataset. An expected rejection is a pass and does not.
      if (result.status === 'errored' || result.status === 'failed') break;
    }

    mutable.finishedAt = now().toISOString();
    mutable.status = steps.some((s) => s.status === 'errored')
      ? 'errored'
      : steps.some((s) => s.status === 'failed')
        ? 'failed'
        : 'passed';
    onProgress?.({ type: 'run-finished', run });
    return run;
  }

  private async runStep(
    step: Step,
    scope: CaptureScope,
    run: { -readonly [K in keyof Run]: Run[K] },
    now: () => Date,
  ): Promise<StepResult> {
    const startedAt = now().toISOString();
    const request = {
      ...step.request,
      path: template(step.request.path, run.variables),
      ...(step.request.idempotencyKey !== undefined
        ? { idempotencyKey: template(step.request.idempotencyKey, run.variables) }
        : {}),
      ...(step.request.body !== undefined
        ? { body: templateDeep(step.request.body, run.variables) }
        : {}),
    };

    try {
      // A leftover {{name}} would be sent literally and come back as a puzzling
      // 404. Catching it here can name the variable and the step that captures
      // it, which is the difference between a two-second fix and a hunt.
      const missing = unresolved(request);
      if (missing.length > 0) {
        throw new MissingVariableError(missing, step.id);
      }
      // Would otherwise go out verbatim and fail as an authentication problem
      // rather than as the unsupported thing it is.
      const secrets = secretReferences(request);
      if (secrets.length > 0) {
        throw new SecretInScenarioError(secrets, step.id);
      }

      const { result: exchange, changes } = await this.options.adapter.capture(scope, () =>
        this.options.runner.send(request),
      );

      if (step.capture) {
        run.variables = { ...run.variables, ...extract(step.capture, exchange.body, exchange.response.status) };
      }

      // Rows a `rows(...)` selector asks for, read once for the whole step.
      //
      // Fetched before evaluation rather than during it because evaluation is
      // synchronous, and made available only through this map so every value
      // goes through the adapter — and therefore inherits `maskColumns` — the
      // same way a captured one does.
      const current = await this.lookupCurrentRows(step.assert ?? [], run.variables, scope);

      const assertions = (step.assert ?? []).map((source) =>
        this.check(source, changes, exchange, run.variables, current),
      );

      // An unstated expectation is not "any status will do". A negative
      // assertion — `hasWrite(changes(*)) == false`, `count(...) == 0` — is
      // evidence only if the request reached the handler; over a 401 or a 500
      // nothing was written because nothing ran, and the assertion passes
      // vacuously. That turns a broken endpoint into a green build precisely
      // for the checks this product exists to make.
      const statusMatched =
        step.expectStatus === undefined
          ? exchange.response.status < 400
          : exchange.response.status === step.expectStatus;
      const failed = assertions.some((a) => a.status === 'failed') || !statusMatched;

      return {
        stepId: step.id,
        name: step.name,
        status: failed
          ? 'failed'
          : step.expectStatus !== undefined
            ? // An expected rejection is a pass, badged differently so a suite
              // whose red is sometimes fine does not train people to ignore red.
              'passed'
            : 'passed',
        startedAt,
        finishedAt: now().toISOString(),
        request: exchange.request,
        response: exchange.response,
        changes,
        // Offered whether or not the step already has assertions: the point is
        // to see what happened and keep the parts that matter.
        ...(() => {
          const promoted = promoteCandidates(changes, run.variables, exchange.response.status);
          return {
            candidates: promoted.candidates,
            ...(promoted.withheld.length > 0 ? { withheldCandidates: promoted.withheld } : {}),
          };
        })(),
        assertions: statusMatched
          ? assertions
          : [
              // Rendered as the assertion the author did not have to write, so
              // the report says which expectation was violated rather than
              // `response.status == undefined`.
              step.expectStatus === undefined
                ? {
                    source: 'response.status < 400',
                    status: 'failed' as const,
                    expected: 'a success status',
                    actual: String(exchange.response.status),
                    reason:
                      'The step did not declare expectStatus, so a success was assumed. ' +
                      'Assertions about what was NOT written prove nothing over a failed ' +
                      'request. Add `expectStatus` if this status is intended.',
                  }
                : {
                    source: `response.status == ${step.expectStatus}`,
                    status: 'failed' as const,
                    expected: String(step.expectStatus),
                    actual: String(exchange.response.status),
                  },
              ...assertions,
            ],
      };
    } catch (error) {
      return {
        stepId: step.id,
        name: step.name,
        status: 'errored',
        startedAt,
        finishedAt: now().toISOString(),
        request: {
          method: request.method,
          url: request.path,
          headers: {},
          ...(request.as !== undefined ? { as: request.as } : {}),
        },
        assertions: [],
        error: describe(error),
      };
    }
  }

  /**
   * Reads the rows every `rows(...)` in this step's assertions asks for.
   *
   * One pass over the assertion sources, one query per distinct selector, and
   * the results handed to the evaluator as a lookup. A selector that cannot be
   * read — no adapter support, an unreadable predicate — is simply absent from
   * the map, and the evaluator then refuses the assertion rather than
   * answering it from the change set, which is what made `rows` a synonym for
   * `changes` and produced passes over rows that were plainly there.
   */
  private async lookupCurrentRows(
    sources: ReadonlyArray<string>,
    variables: Readonly<Record<string, string>>,
    scope: CaptureScope,
  ): Promise<CurrentRows> {
    const found = new Map<string, RowsRead>();
    const refusals = new Map<string, string>();
    const adapter = this.options.adapter;
    if (!adapter.readRows) return { rows: found, refusals };

    for (const source of sources) {
      let selectors: ReadonlyArray<Selector>;
      try {
        selectors = rowsSelectorsIn(parseExpr(template(source, variables, { quote: true })));
      } catch {
        // A source that will not parse fails in `check`, with a better message.
        continue;
      }
      for (const selector of selectors) {
        if (!selector.table) continue;
        const key = `${selector.table}\u0000${selector.predicate ?? ''}`;
        if (found.has(key)) continue;
        try {
          const clauses = selector.predicate ? predicateClauses(selector.predicate) : [];
          found.set(key, await adapter.readRows(selector.table, clauses, scope));
        } catch (error) {
          // Left out of the map on purpose: the evaluator refuses a selector it
          // cannot read, which is the honest answer. But *why* it could not be
          // read is kept, because the generic message below is useless for the
          // one case the reader can act on — a predicate over a masked column
          // is fixed by editing `maskColumns`, and "could not be read" does not
          // say so.
          if (error instanceof ValueUnavailable || error instanceof Unevaluable) {
            refusals.set(key, error.message);
          }
        }
      }
    }
    return { rows: found, refusals };
  }

  private check(
    source: string,
    changes: ChangeSet,
    exchange: { response: { status: number; headers: Record<string, string> }; body: unknown },
    variables: Readonly<Record<string, string>>,
    current: CurrentRows,
  ): AssertionResult {
    const templated = template(source, variables, { quote: true });
    // A surviving `{{name}}` means nothing captured it. Predicates are raw
    // source slices rather than parsed nodes, so the evaluator's own
    // "no variable was captured" guard never sees them — the text is compared
    // against the column literally, matches nothing, and every negative
    // assertion built on it passes for the wrong reason.
    const stranded = [...templated.matchAll(PLACEHOLDER)].map((m) => m[1]);
    if (stranded.length > 0) {
      return {
        source,
        status: 'unevaluable',
        reason:
          `nothing captured ${stranded.map((n) => `\`${n}\``).join(', ')}, so this assertion ` +
          `was never evaluated against a real value`,
      };
    }

    try {
      const expr = parseExpr(templated);
      const { passed, actual, expected } = evaluateAssertion(expr, {
        changes,
        response: {
          status: exchange.response.status,
          headers: exchange.response.headers,
          body: exchange.body,
        },
        variables,
        lookupRows: (table, predicate) => {
          const key = `${table ?? ''}\u0000${predicate ?? ''}`;
          const read = current.rows.get(key);
          if (read) return read;
          const why = current.refusals.get(key);
          throw new Unevaluable(why ?? `the rows of \`${table ?? '*'}\` could not be read`);
        },
      });
      return {
        source,
        status: passed ? 'passed' : 'failed',
        actual,
        ...(expected !== undefined ? { expected } : {}),
      };
    } catch (error) {
      if (error instanceof Unevaluable || error instanceof ExprSyntaxError) {
        // Not a failure: "this could not be checked" and "this was checked and
        // is wrong" call for different actions, so they get different statuses.
        return { source, status: 'unevaluable', reason: error.message };
      }
      throw error;
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function template(
  text: string,
  variables: Readonly<Record<string, string>>,
  options?: { quote?: boolean },
): string {
  return text.replace(PLACEHOLDER, (match, name: string, offset: number) => {
    const value = variables[name];
    if (value === undefined) return match;
    if (!options?.quote) return value;
    // Already inside quotes — as `where(id = '{{payment_id}}')` is, matching how
    // the examples quote every other literal. Quoting again yields `"p1"` with
    // the quotes part of the value, which matches no row, so a `count(...) == 0`
    // written to catch a duplicate passes while the duplicate sits in the diff.
    const before = text[offset - 1];
    const after = text[offset + match.length];
    if ((before === '"' || before === "'") && before === after) return value;
    return JSON.stringify(value);
  });
}

function templateDeep(value: unknown, variables: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return template(value, variables);
  if (Array.isArray(value)) return value.map((v) => templateDeep(v, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, templateDeep(v, variables)]),
    );
  }
  return value;
}

/** Pulls `{ payment_id: 'response.body.id' }` out of a response. */
function extract(
  spec: Readonly<Record<string, string>>,
  body: unknown,
  status: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(spec)) {
    const segments = path.replace(/^response\./, '').split('.');
    if (segments[0] === 'status') {
      out[name] = String(status);
      continue;
    }
    let cursor: unknown = segments[0] === 'body' ? body : body;
    for (const key of segments[0] === 'body' ? segments.slice(1) : segments) {
      if (cursor === null || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor !== undefined && cursor !== null) {
      out[name] = typeof cursor === 'object' ? JSON.stringify(cursor) : String(cursor);
    }
  }
  return out;
}

function describe(error: unknown): NonNullable<StepResult['error']> {
  if (error instanceof MissingVariableError) {
    return {
      kind: 'configuration',
      message: error.message,
      remedy:
        'Run the whole dataset once so the earlier steps capture it, or start from ' +
        'the step that does.',
    };
  }
  if (error instanceof HttpRunnerError) {
    return {
      kind: 'request',
      message: error.message,
      remedy: `Check that the backend is running and reachable at ${error.url}.`,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|ENOTFOUND|password authentication|does not exist/i.test(message)) {
    return { kind: 'database', message, remedy: 'Check the database connection for this workspace.' };
  }
  return { kind: 'capture', message };
}

/**
 * The variables a run starts with.
 *
 * A full run always gets fresh built-ins: reusing a previous `{{run}}` would
 * replay that run's idempotency keys, and the dataset would collide with
 * itself rather than with any real defect.
 *
 * A partial run is the opposite case. Its whole premise is "the earlier steps
 * already happened", and it is already carrying `payment_id` from that run —
 * so minting a fresh `{{run}}` would pair one run's captured ids with another
 * run's suffix. That mixture is not a replay of anything: the idempotency key
 * would not match, and a step meant to test a duplicate request would instead
 * send a genuinely new one. So a partial run inherits the whole context,
 * built-ins included.
 */
function builtins(now: () => Date, options: RunOptions): Record<string, string> {
  const fresh = {
    run: now().getTime().toString(36).slice(-6),
    now: now().toISOString(),
  };
  const partial = Boolean(options.fromStepId || options.onlyStepId);
  if (!partial || !options.variables) return { ...options.variables, ...fresh };
  return { ...fresh, ...options.variables };
}

/** Picks the steps a run should execute, honouring `fromStepId` / `onlyStepId`. */
function selectSteps(dataset: Dataset, options: RunOptions): ReadonlyArray<Step> {
  if (options.onlyStepId) {
    const step = dataset.steps.find((s) => s.id === options.onlyStepId);
    if (!step) {
      throw new Error(
        `Dataset \`${dataset.id}\` has no step \`${options.onlyStepId}\`. ` +
          `Available: ${dataset.steps.map((s) => s.id).join(', ')}.`,
      );
    }
    return [step];
  }
  if (options.fromStepId) {
    const index = dataset.steps.findIndex((s) => s.id === options.fromStepId);
    if (index === -1) {
      throw new Error(
        `Dataset \`${dataset.id}\` has no step \`${options.fromStepId}\`. ` +
          `Available: ${dataset.steps.map((s) => s.id).join(', ')}.`,
      );
    }
    return dataset.steps.slice(index);
  }
  return dataset.steps;
}

class MissingVariableError extends Error {
  constructor(
    readonly names: ReadonlyArray<string>,
    readonly stepId: string,
  ) {
    super(
      `Step \`${stepId}\` needs ${names.map((n) => `\`${n}\``).join(', ')}, which nothing has captured yet.`,
    );
    this.name = 'MissingVariableError';
  }
}

/** Names still wrapped in braces after templating — i.e. never captured. */
function unresolved(request: { path: string; body?: unknown; idempotencyKey?: string }): string[] {
  const found = new Set<string>();
  const scan = (text: string): void => {
    for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      found.add(match[1]!);
    }
  };
  scan(request.path);
  if (request.idempotencyKey) scan(request.idempotencyKey);
  if (request.body !== undefined) scan(JSON.stringify(request.body) ?? '');
  return [...found];
}

/**
 * A secret reference that reached a request.
 *
 * `\${secret:…}` is resolved in the workspace file, which is where credentials
 * belong: `identities` exists so that authentication is declared once and a
 * step says `as: alice`. A scenario is not resolved, so a reference written
 * into one would be sent as those characters and come back as a puzzling 401 —
 * the same silent passthrough that the workspace grammar closed.
 *
 * Refusing is the honest answer while scenarios do not resolve them. It is not
 * a permanent one: if a scenario genuinely needs a credential that is not
 * authentication — a webhook signing key in a body — that is the evidence for
 * resolving them here too, and this error is where that will be noticed.
 */
export class SecretInScenarioError extends Error {
  constructor(
    readonly names: ReadonlyArray<string>,
    stepId: string,
  ) {
    super(
      `Step \`${stepId}\` refers to ${names.map((n) => `\`\${secret:${n}}\``).join(', ')}, and ` +
        `scenario files do not resolve secret references — it would be sent to the API as those ` +
        `characters. Put the credential in \`identities\` in the workspace file, which does ` +
        `resolve them, and select it from the step with \`as:\`.`,
    );
    this.name = 'SecretInScenarioError';
  }
}

function secretReferences(request: unknown): string[] {
  const found = new Set<string>();
  for (const match of (JSON.stringify(request) ?? '').matchAll(/\$\{secret:([a-z0-9][a-z0-9_-]*)\}/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

export * from './load.js';
export * from './promote.js';
export * from './save.js';

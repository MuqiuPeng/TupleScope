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
} from '@tuplescope/expr';
import { HttpRunner, HttpRunnerError } from '@tuplescope/http-runner';
import { promoteCandidates } from './promote.js';
import {
  describeReference,
  INSTEAD_OF_A_REFERENCE,
  referencesIn,
  SECRET_REFERENCE,
  unescapeDeep,
  unescapeReferences,
  type RequestReference,
} from './references.js';
import { ValueUnavailable } from '@tuplescope/core';
import type {
  AssertionResult,
  CaptureScope,
  ChangeSet,
  DatabaseAdapter,
  Dataset,
  Expr,
  RowsRead,
  Run,
  Scenario,
  Selector,
  Step,
  StepResult,
} from '@tuplescope/core';

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

    const declared = selectSteps(dataset, options);
    // Recorded before the loop, so halting early cannot shrink the denominator
    // along with the numerator.
    mutable.declaredSteps = declared.map((step) => step.id);

    for (const step of declared) {
      const result = await this.runStep(step, scope, mutable, now, dataset.steps);
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
    /** The whole dataset, in order — so a missing variable can name the step that captures it. */
    steps: ReadonlyArray<Step>,
  ): Promise<StepResult> {
    const startedAt = now().toISOString();
    // `$${` becomes `${` in the author's text, before any captured value is put
    // in. A value from the API is data, so a `$${` inside one is sent as it came.
    const request = {
      ...step.request,
      path: template(unescapeReferences(step.request.path), run.variables),
      // Templated like the path and the body. A header was the one place a
      // `{{name}}` went out as those characters, captured or not, and the step
      // passed (measured: ts-fix2/engine-ws/probe.mjs).
      ...(step.request.headers !== undefined
        ? {
            headers: templateDeep(unescapeDeep(step.request.headers), run.variables) as Readonly<
              Record<string, string>
            >,
          }
        : {}),
      ...(step.request.idempotencyKey !== undefined
        ? { idempotencyKey: template(unescapeReferences(step.request.idempotencyKey), run.variables) }
        : {}),
      ...(step.request.body !== undefined
        ? { body: templateDeep(unescapeDeep(step.request.body), run.variables) }
        : {}),
    };

    try {
      // A leftover {{name}} would be sent literally and come back as a puzzling
      // 404. Catching it here can name the variable and the step that captures
      // it, which is the difference between a two-second fix and a hunt.
      const missing = unresolved(request);
      if (missing.length > 0) {
        throw new MissingVariableError(missing, step.id, steps);
      }
      // Every `${…}`, not only the exact `${secret:name}` spelling: `${VAR}` in
      // a header, `${VAR:-default}` in a body, `${secret: x}` and `${SECRET:x}`
      // all went out as those characters, and the step passed. Read off the
      // author's text rather than the request about to be sent, because a `${`
      // in a captured value is data, not a reference.
      const references = referencesIn(step.request);
      if (references.length > 0) {
        throw references.every((r) => SECRET_REFERENCE.test(r.reference))
          ? new SecretInScenarioError(
              [...new Set(references.map((r) => SECRET_REFERENCE.exec(r.reference)![1]!))],
              step.id,
            )
          : new ReferenceInScenarioError(references, step.id);
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
    // A `{{name}}` nothing captured. Predicates are raw source slices rather
    // than parsed nodes, so the evaluator's own "no variable was captured"
    // guard never sees them — the text is compared against the column
    // literally, matches nothing, and every negative assertion built on it
    // passes for the wrong reason.
    //
    // Read from the source, not from the templated text: a captured value that
    // itself contains `{{x}}` is data, and must not read as a missing variable.
    const stranded = [
      ...new Set([...source.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((n) => variables[n] === undefined)),
    ];
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
      // Inside the try: a captured value that cannot be placed without
      // changing the question is refused as `Unevaluable`, like any other
      // assertion this run cannot decide.
      const templated = template(source, variables, { quote: true });
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
  if (options?.quote) return templateExpression(text, variables);
  return text.replace(PLACEHOLDER, (match, name: string) => variables[name] ?? match);
}

/** One `{{name}}` in an assertion, and whether it stands inside a string literal. */
interface Slot {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  /** The literal's quote character, or null for a placeholder standing on its own. */
  readonly quote: '"' | "'" | null;
}

/**
 * Every placeholder in an assertion, located by the expression lexer's rules.
 *
 * Mirrors `tokenize` in packages/expr/src/parse.ts: outside a string, `{{`
 * runs to the next `}}` as one token and a quote there opens nothing; inside a
 * string, a backslash takes the next character with it, and only the opening
 * quote closes it. Deciding by the characters either side of the placeholder
 * — which is what this replaced — saw `"PVT-{{x}}"` as a bare placeholder and
 * produced `"PVT-"pay_1""`, and saw `"{{x}}"` as safely quoted however many
 * quotes the captured value itself contained.
 */
function slotsIn(text: string): Slot[] {
  const slots: Slot[] = [];
  const at = (index: number, quote: Slot['quote']): number | undefined => {
    const match = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/y;
    match.lastIndex = index;
    const found = match.exec(text);
    if (!found) return undefined;
    slots.push({ start: index, end: index + found[0].length, name: found[1]!, quote });
    return index + found[0].length;
  };
  let quote: Slot['quote'] = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      i = at(i, quote) ?? i + 1;
      continue;
    }
    if (text.startsWith('{{', i)) {
      const close = text.indexOf('}}', i + 2);
      // Unterminated: the lexer refuses it, in its own words.
      if (close === -1) break;
      at(i, null);
      i = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    i++;
  }
  return slots;
}

/**
 * Puts captured values into an assertion so each lands as exactly one literal.
 *
 * A captured value comes from an API response, so it is data that must never
 * become syntax. Standing on its own a placeholder becomes a quoted literal;
 * inside a literal it is spliced as text, escaped by the lexer's rule — a
 * backslash before the quote character and before a backslash. Before this, a
 * placeholder the author had quoted was spliced raw, so a value of
 * `x" or "a" == "a` turned `response.body.label == "{{v}}"` into a comparison
 * that is always true.
 *
 * Predicates are the exception, and the reason is in packages/expr: a
 * predicate is handed to `parsePredicate` as raw source, and its quoted values
 * have no escapes at all. There, `\"` is a backslash followed by a closing
 * quote, and `a\\b` is four characters — an escaped value would silently ask a
 * different question than the one written, which is a green nobody can see
 * through. So a value that needs escaping inside a predicate is refused,
 * rather than spliced wrongly. An ordinary id needs no escaping, which is why
 * `rows(t, id = "{{id}}")` and `.where(id = '{{id}}')` read as before.
 */
function templateExpression(text: string, variables: Readonly<Record<string, string>>): string {
  const slots = slotsIn(text).filter((slot) => variables[slot.name] !== undefined);
  const needsEscape = (slot: Slot): boolean =>
    /[\\]/.test(variables[slot.name]!) || variables[slot.name]!.includes(slot.quote ?? '"');
  const inPredicate = slots.some(needsEscape) ? predicateSlots(text, slots) : undefined;

  let out = '';
  let from = 0;
  slots.forEach((slot, index) => {
    const value = variables[slot.name]!;
    out += text.slice(from, slot.start);
    from = slot.end;
    if (needsEscape(slot) && (inPredicate === null || inPredicate?.has(index))) {
      const quote = slot.quote ?? '"';
      throw new Unevaluable(
        `the captured \`${slot.name}\` contains ${value.includes(quote) ? `a \`${quote}\`` : 'a backslash'}, ` +
          `and it would land inside a predicate's quoted value, which has no escapes — spliced in, ` +
          `it would change what the predicate asks. Select the row by a column whose value is ` +
          `plain, or compare \`{{${slot.name}}}\` outside the predicate.`,
      );
    }
    const escaped = value.replace(slot.quote === "'" ? /[\\']/g : /[\\"]/g, (c) => `\\${c}`);
    out += slot.quote ? escaped : `"${escaped}"`;
  });
  return out + text.slice(from);
}

/**
 * Which slots sit inside a predicate, read off the real parser.
 *
 * Each slot is swapped for a marker the lexer takes as plain string content,
 * and the predicates of the parsed tree are searched for the markers. `null`
 * when the source will not parse — then no slot can be placed, and the caller
 * refuses rather than guess.
 */
function predicateSlots(text: string, slots: ReadonlyArray<Slot>): ReadonlySet<number> | null {
  // NUL can sit in a string literal and in a predicate's quoted value, and no
  // scenario file writes one, so a marker cannot be mistaken for authored text.
  const marker = (index: number): string => `\u0000${index}\u0000`;
  let marked = '';
  let from = 0;
  slots.forEach((slot, index) => {
    marked += text.slice(from, slot.start) + (slot.quote ? marker(index) : `"${marker(index)}"`);
    from = slot.end;
  });
  marked += text.slice(from);
  let expr: Expr;
  try {
    expr = parseExpr(marked);
  } catch {
    return null;
  }
  const predicates: string[] = [];
  const walk = (node: Expr): void => {
    switch (node.node) {
      case 'select':
        if (node.selector.predicate) predicates.push(node.selector.predicate);
        return;
      case 'predicate':
        predicates.push(node.predicate);
        walk(node.source);
        return;
      case 'column':
      case 'aggregate':
      case 'hasWrite':
      case 'isEmpty':
      case 'atomic':
      case 'writeCount':
        walk(node.source);
        return;
      case 'compare':
      case 'logical':
        walk(node.left);
        walk(node.right);
        return;
      case 'not':
        walk(node.operand);
        return;
      default:
        return;
    }
  };
  walk(expr);
  const found = new Set<number>();
  slots.forEach((_, index) => {
    if (predicates.some((p) => p.includes(marker(index)))) found.add(index);
  });
  return found;
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
  // A problem in the scenario file. These fell through to `capture`, which is
  // what the step's status column and the web UI print, and it sent the reader
  // to the database for a line they had written.
  if (error instanceof SecretInScenarioError || error instanceof ReferenceInScenarioError) {
    return { kind: 'configuration', message: error.message };
  }
  if (error instanceof MissingVariableError) {
    return {
      kind: 'configuration',
      message: error.message,
      remedy: error.remedy,
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
  /**
   * What to do about it, naming the step that captures each variable.
   *
   * "Start from the step that does" left the reader to open the file and find
   * it — and when no earlier step captures the name at all (a typo, or a
   * capture placed after its first use), no step would ever do, and the advice
   * sent them looking for one.
   */
  readonly remedy: string;

  constructor(
    readonly names: ReadonlyArray<string>,
    readonly stepId: string,
    steps: ReadonlyArray<Step>,
  ) {
    super(
      `Step \`${stepId}\` needs ${names.map((n) => `\`${n}\``).join(', ')}, which nothing has captured yet.`,
    );
    this.name = 'MissingVariableError';

    const index = steps.findIndex((s) => s.id === stepId);
    const capturing = (list: ReadonlyArray<Step>, name: string): string[] =>
      list.filter((s) => s.capture && Object.hasOwn(s.capture, name)).map((s) => `\`${s.id}\``);
    const found: string[] = [];
    const lost: string[] = [];
    for (const name of names) {
      const earlier = capturing(steps.slice(0, Math.max(index, 0)), name);
      if (earlier.length > 0) {
        found.push(`\`${name}\` is captured by ${earlier.join(' or ')}`);
        continue;
      }
      const later = capturing(steps.slice(Math.max(index, 0)), name);
      lost.push(
        later.length > 0
          ? `\`${name}\` is captured only by ${later.join(' or ')}, which runs after \`${stepId}\``
          : `No step before \`${stepId}\` captures \`${name}\``,
      );
    }
    this.remedy =
      lost.length === 0
        ? 'Run the whole dataset once so the earlier steps capture it, or start from the step ' +
          `that does: ${found.join('; ')}.`
        : `${lost.join('; ')} — check the spelling, or capture it in an earlier step.` +
          (found.length > 0 ? ` (${found.join('; ')}.)` : '');
  }
}

/** Names still wrapped in braces after templating — i.e. never captured. */
function unresolved(request: {
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  headers?: Readonly<Record<string, string>>;
}): string[] {
  const found = new Set<string>();
  const scan = (text: string): void => {
    for (const match of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      found.add(match[1]!);
    }
  };
  scan(request.path);
  if (request.idempotencyKey) scan(request.idempotencyKey);
  if (request.body !== undefined) scan(JSON.stringify(request.body) ?? '');
  if (request.headers !== undefined) scan(JSON.stringify(request.headers));
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

/**
 * Any other `${…}` that reached a request: an environment reference, a
 * misspelled secret, anything else of that shape.
 *
 * Refused, not sent. Nothing in a scenario file resolves one, so the characters
 * would reach the API unchanged, and a header that went out as
 * `Bearer ${TOKEN}` failed as an authentication problem, if it failed at all. A
 * body field that went out as `${MERCHANT_ID:-m1}` failed nowhere. The sentence
 * names each field and says what to write instead.
 */
export class ReferenceInScenarioError extends Error {
  constructor(
    readonly references: ReadonlyArray<RequestReference>,
    stepId: string,
  ) {
    const found = references.map(describeReference);
    super(
      `Step \`${stepId}\`: ${found.length === 1 ? found[0] : `${found.slice(0, -1).join(', ')} and ${found.at(-1)}`}, ` +
        `and a scenario file resolves no \`\${…}\` reference, so ${found.length === 1 ? 'it' : 'they'} would ` +
        `reach the API as those characters — ${INSTEAD_OF_A_REFERENCE}.`,
    );
    this.name = 'ReferenceInScenarioError';
  }
}

export * from './load.js';
export * from './promote.js';
export * from './save.js';
export * from './audit.js';

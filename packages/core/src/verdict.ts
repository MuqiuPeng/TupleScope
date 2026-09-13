/**
 * What a run establishes, and what it does not.
 *
 * This is where the product's one non-negotiable claim is enforced: a run must
 * never report success it cannot support. Every other layer can be lenient;
 * this one decides.
 *
 * It lives in Core rather than in the CLI because the same judgement has to
 * reach three consumers — a terminal, a CI exit code, and an MCP tool result —
 * and a judgement re-derived per consumer is a judgement that will differ per
 * consumer. `verdictOf` takes the policy and *records* it, so a caller receives
 * a self-describing answer rather than a number it has to interpret.
 *
 * The engine cannot do this itself. Its `Run.status` folds only step statuses,
 * so a run whose every assertion was `unevaluable` is `passed` there — correct
 * for the engine, which is reporting whether the steps executed, and wrong as a
 * verdict. Widening `RunStatus` is not the fix: it is shared between `Run` and
 * `StepResult` and every consumer switches on it exhaustively.
 */

import type { AssertionResult, AssertionStatus } from './assertion.js';
import type { CaptureWarning } from './changeset.js';
import type { ExecutionError, Run, StepResult } from './run.js';

// ─── outcomes ─────────────────────────────────────────────────────────────────

/**
 * `undecided` is the one that earns its place. It means the run completed and
 * nothing contradicted it, but some part of what it claims to check was never
 * actually checked. Collapsing it into `clean` is the forbidden green; collapsing
 * it into `failed` would make "open a bug against the backend" ambiguous.
 */
export type RunOutcome = 'clean' | 'failed' | 'undecided' | 'errored';

export type StepOutcome = 'passed' | 'failed' | 'errored' | 'undecided' | 'not-run';

/** Whether the verdict covers everything it set out to, or is qualified. */
export type Proves = 'full' | 'bounded';

// ─── policy ───────────────────────────────────────────────────────────────────

export interface VerdictPolicy {
  /** Whether an undecided assertion reaches the outcome. */
  unevaluable: 'error' | 'warn';
  /** `strict` escalates every capture warning; `off` demotes every one. */
  warnings: 'default' | 'strict' | 'off';
  /** Whether a run that evaluated no assertions at all is undecided. */
  requireAssertions: boolean;
}

/**
 * Strict about undecided, lenient about warnings, quiet about zero assertions.
 *
 * The asymmetry is deliberate. Being lenient on `concurrent-writes-detected` is
 * what makes strictness on `unevaluable` survivable: a suite that is red every
 * day for something the operator cannot fix gets `|| true`'d, and that same
 * `|| true` would then swallow the undecided signal this policy exists to
 * protect.
 */
export const DEFAULT_POLICY: VerdictPolicy = {
  unevaluable: 'error',
  warnings: 'default',
  requireAssertions: false,
};

// ─── capture warnings ─────────────────────────────────────────────────────────

/**
 * Which warnings mean the observation had no standing to return a verdict.
 *
 * The discriminator: was the observation *smaller or blunter than it claims* —
 * in which case an assertion that passed over it proved nothing — or was it
 * complete but ambiguously attributed, where the verdict stands and only the
 * ownership of extra rows is in doubt?
 */
export const WARNING_SEVERITY: Readonly<Record<CaptureWarning['code'], 'error' | 'warn'>> = {
  // The ChangeSet is admittedly incomplete. `hasWrite(changes(*)) == false`
  // passing over a truncated scope is `unevaluable` in different clothing.
  'scope-truncated': 'error',
  // Capture ran in a mode blind to some class of change. Note the trap this
  // closes: the evaluator's detection check reads `changes.detection` and never
  // `changes.warnings`, so a ChangeSet can say `write` and carry this warning,
  // and the flagship assertion evaluates normally and passes.
  'reduced-fidelity': 'error',
  // Rows counted but not paired. The mis-decision this threatens is caught
  // precisely at the assertion instead, so it need not redden a whole run
  // because one unrelated table has no primary key.
  'degraded-row-identity': 'warn',
  // The observation is complete and correct; something else also writes here.
  // Outbox pollers and session sweepers are ordinary on a running dev machine.
  'concurrent-writes-detected': 'warn',
  // The values came back from this connection and every assertion over them is
  // decided; the text is simply not portable to a second tool. Reddening a run
  // whose assertions all held, over a property no assertion depends on, is the
  // kind of noise that gets a suite `|| true`'d.
  'rendering-not-pinned': 'warn',
};

/** Unknown codes escalate: a warning from a newer producer is not one to guess about. */
export function severityOf(code: string): 'error' | 'warn' {
  return (WARNING_SEVERITY as Record<string, 'error' | 'warn' | undefined>)[code] ?? 'error';
}

export function resolveSeverity(code: string, policy: VerdictPolicy): 'error' | 'warn' {
  if (policy.warnings === 'strict') return 'error';
  if (policy.warnings === 'off') return 'warn';
  return severityOf(code);
}

/**
 * A warning with everything a reader needs to act on it: where it came from,
 * whether policy changed its severity, and what it costs the verdict.
 *
 * `--warnings off` demotes, it never hides. A warning absent from the report is
 * a warning that will be discovered in production instead.
 */
export interface LocatedWarning extends CaptureWarning {
  severity: 'error' | 'warn';
  /** True when policy moved it off its natural severity, in either direction. */
  escalated: boolean;
  source: 'baseline' | 'step';
  stepId?: string;
  /** One sentence on what this warning stops the run from proving. */
  bounds: string;
}

const BOUNDS: Readonly<Record<string, string>> = {
  'scope-truncated':
    'the observation was cut short, so an assertion that found nothing may only have been looking at less',
  'reduced-fidelity':
    'capture ran in a mode blind to some class of change, so an assertion about mutations may have missed one',
  'degraded-row-identity':
    'rows in this table could be counted but not matched to their previous version',
  'concurrent-writes-detected':
    'something else writes to this database, so rows here may not have been caused by the scenario',
};

function boundsOf(code: string): string {
  return BOUNDS[code] ?? 'this run may be reporting less than the whole picture';
}

// ─── what bounds a verdict, in words ──────────────────────────────────────────
//
// Named, because `mergeVerdicts` has to recognise each per-run sentence to say
// what it means for a suite. Folding them by string identity alone undercounted
// (two datasets' "1 undecided assertion was not counted" became one sentence
// beside counts of 2) and leaked (a suite whose checks read 1/1 passed was told
// "no assertions were evaluated", a sentence true of two of its three datasets).

const PARTIAL_BOUND =
  'this run started mid-dataset, so earlier steps left the database in whatever state the previous run did';
const UNPROBED_BOUND = 'the baseline was not probed, so concurrent writes would not have been detected';
const UNCHECKED_OBSERVED = 'no assertions were evaluated; the run observed changes but checked none of them';
// A step refused before it sent — a `${…}` in its request, a variable nothing
// captured — observed nothing. The sentence above said it "observed changes".
const UNCHECKED_UNOBSERVED =
  'no assertions were evaluated, and no step got as far as observing the database, so nothing was observed either';
const BY_POLICY_BOUND = /^\d+ undecided assertions? (?:was|were) not counted against this run, by policy$/;

function byPolicyBound(unevaluable: number): string {
  return (
    `${unevaluable} undecided assertion${unevaluable === 1 ? ' was' : 's were'} ` +
    'not counted against this run, by policy'
  );
}

/** `accounts, addresses, blocks and 32 more` — names, capped; never only a count. */
function tablesOf(same: ReadonlyArray<LocatedWarning>): string {
  const names = [...new Set(same.flatMap((w) => (w.table ? [w.table] : [])))];
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/**
 * One line per kind of warning, naming its tables. A step that truncated
 * thirty-five tables used to leave thirty-five copies of the same sentence and
 * none of the table names.
 */
function warningBounds(warnings: ReadonlyArray<LocatedWarning>): string[] {
  return [...new Set(warnings.map((w) => w.code))].map((code) => {
    const same = warnings.filter((w) => w.code === code);
    const where = tablesOf(same);
    return where ? `${same[0]!.bounds} (${where})` : same[0]!.bounds;
  });
}

// ─── counts ───────────────────────────────────────────────────────────────────

export interface AssertionCounts {
  total: number;
  passed: number;
  failed: number;
  unevaluable: number;
  passedAsRefused: number;
}

export interface StepCounts {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  undecided: number;
  notRun: number;
  /** Steps that ran and asserted nothing. Observed, but checked by no one. */
  unchecked: number;
}

export interface DatasetCounts {
  total: number;
  clean: number;
  failed: number;
  undecided: number;
  errored: number;
}

// ─── the verdict ──────────────────────────────────────────────────────────────

export interface RunVerdict {
  outcome: RunOutcome;
  /** One sentence naming the single thing that decided the outcome. */
  reason: string;
  assertions: AssertionCounts;
  steps: StepCounts;
  coverage: 'full' | 'partial';
  proves: Proves;
  /** Every reason this verdict is qualified, in the order a reader should see them. */
  boundedBy: ReadonlyArray<string>;
  baseline: { probed: boolean; windowMs: number; clean: boolean };
  warnings: ReadonlyArray<LocatedWarning>;
  errors: ReadonlyArray<{ stepId: string } & ExecutionError>;
  durationMs: number;
  /** Echoed back so a consumer can see what judgement it is reading. */
  policy: VerdictPolicy;
}

export interface SuiteVerdict extends Omit<RunVerdict, 'coverage'> {
  datasets: DatasetCounts;
  coverage: 'full' | 'partial' | 'mixed';
}

const ZERO_ASSERTIONS: AssertionCounts = {
  total: 0,
  passed: 0,
  failed: 0,
  unevaluable: 0,
  passedAsRefused: 0,
};

function countAssertions(results: ReadonlyArray<AssertionResult>): AssertionCounts {
  const counts = { ...ZERO_ASSERTIONS };
  for (const result of results) {
    counts.total++;
    const status: AssertionStatus = result.status;
    if (status === 'passed') counts.passed++;
    else if (status === 'failed') counts.failed++;
    else if (status === 'unevaluable') counts.unevaluable++;
    else counts.passedAsRefused++;
  }
  return counts;
}

/**
 * What one step established.
 *
 * A step whose assertions all evaluated and passed is `passed`; one carrying an
 * undecided assertion is `undecided` under the strict policy, because the step
 * did not establish what it says it establishes.
 *
 * So is a step whose own capture carried a warning the policy escalates — the
 * rule `verdictOf` applies to the run, applied to the step it came from. This
 * returned `passed` for a step whose observation was `scope-truncated` inside a
 * run that exited 3, and the web UI, which draws each step from this, put a
 * green tick on the one step whose observation was cut short (measured on the
 * payment API's `/debug/reset`, ts-verify re-honesty-runtime run_mtxeox8c).
 */
export function outcomeOfStep(
  step: StepResult,
  policy: VerdictPolicy = DEFAULT_POLICY,
): StepOutcome {
  if (step.status === 'errored') return 'errored';
  if (step.status === 'skipped' || step.status === 'pending') return 'not-run';
  if (step.status === 'failed') return 'failed';
  if (step.assertions.some((a) => a.status === 'failed')) return 'failed';
  if (policy.unevaluable === 'error' && step.assertions.some((a) => a.status === 'unevaluable')) {
    return 'undecided';
  }
  if ((step.changes?.warnings ?? []).some((w) => resolveSeverity(w.code, policy) === 'error')) {
    return 'undecided';
  }
  return 'passed';
}

/**
 * Whether a step got as far as observing the database. `changes` is absent only
 * when a step stopped before its observation completed (StepResult), and a step
 * that passed or failed got through it. A step refused before it sent — a
 * `${…}` in its request, a variable nothing captured — did not.
 */
function observedStep(step: StepResult): boolean {
  return step.changes !== undefined || step.status === 'passed' || step.status === 'failed';
}

function locateWarnings(run: Run, policy: VerdictPolicy): LocatedWarning[] {
  const out: LocatedWarning[] = [];
  const add = (warning: CaptureWarning, source: 'baseline' | 'step', stepId?: string): void => {
    const severity = resolveSeverity(warning.code, policy);
    out.push({
      ...warning,
      severity,
      escalated: severity !== severityOf(warning.code),
      source,
      ...(stepId !== undefined ? { stepId } : {}),
      bounds: boundsOf(warning.code),
    });
  };

  for (const warning of run.baselineNoise?.warnings ?? []) add(warning, 'baseline');
  for (const step of run.steps) {
    for (const warning of step.changes?.warnings ?? []) add(warning, 'step', step.stepId);
  }
  return out;
}

/**
 * The whole judgement for one run.
 *
 * Precedence is `errored` > `failed` > `undecided` > `clean`, and it is decided
 * here and nowhere else. The order is by what the reader must do first, not by
 * severity: an execution error means part of the suite never ran, so a `failed`
 * beneath it would be a verdict over an incomplete suite.
 */
export function verdictOf(run: Run, policy: VerdictPolicy = DEFAULT_POLICY): RunVerdict {
  const assertions = countAssertions(run.steps.flatMap((step) => step.assertions));

  // The steps the run set out to execute, not the ones it reached. A dataset
  // that halts on step 2 of 5 has three steps nobody looked at, and reporting
  // `total: 2` makes them disappear rather than count.
  const declared = run.declaredSteps ?? run.steps.map((s) => s.stepId);
  const attempted = new Set(run.steps.map((s) => s.stepId));
  const unreached = declared.filter((id) => !attempted.has(id));

  const steps: StepCounts = {
    total: declared.length,
    passed: 0,
    failed: 0,
    errored: 0,
    undecided: 0,
    notRun: 0,
    unchecked: 0,
  };
  for (const step of run.steps) {
    const outcome = outcomeOfStep(step, policy);
    if (outcome === 'passed') steps.passed++;
    else if (outcome === 'failed') steps.failed++;
    else if (outcome === 'errored') steps.errored++;
    else if (outcome === 'undecided') steps.undecided++;
    else steps.notRun++;
    // "Observed, but checked by no one" — so not a step refused before it
    // observed anything. The stored refused runs (ts-verify re-cli-run-flags,
    // topup/ghost and uncaptured/novar) counted their errored step here too.
    if (outcome !== 'not-run' && step.assertions.length === 0 && observedStep(step)) steps.unchecked++;
  }
  steps.notRun += unreached.length;

  const warnings = locateWarnings(run, policy);
  const escalating = warnings.filter((w) => w.severity === 'error');

  const errors = run.steps
    .filter((step): step is StepResult & { error: ExecutionError } => step.error !== undefined)
    .map((step) => ({ stepId: step.stepId, ...step.error }));

  const baseline = {
    probed: run.baseline?.probed ?? false,
    windowMs: run.baseline?.windowMs ?? 0,
    clean: (run.baselineNoise?.changes.length ?? 0) === 0,
  };

  const noAssertions = policy.requireAssertions && assertions.total === 0;

  let outcome: RunOutcome;
  let reason: string;
  if (steps.errored > 0) {
    outcome = 'errored';
    reason = `${errors[0]?.message ?? 'a step could not be executed'}`;
  } else if (steps.failed > 0 || assertions.failed > 0) {
    outcome = 'failed';
    reason =
      assertions.failed > 0
        ? `${assertions.failed} assertion${assertions.failed === 1 ? '' : 's'} failed`
        : `${steps.failed} step${steps.failed === 1 ? '' : 's'} failed`;
  } else if (policy.unevaluable === 'error' && assertions.unevaluable > 0) {
    outcome = 'undecided';
    reason =
      `${assertions.unevaluable} assertion${assertions.unevaluable === 1 ? '' : 's'} could not be ` +
      `evaluated, so this run did not establish what it claims to check`;
  } else if (escalating.length > 0) {
    outcome = 'undecided';
    // Which warning, and where. This used to read "the observation was
    // incomplete: the observation was cut short, …" — naming neither the
    // truncation nor any of the thirty-five tables it happened to. Measured on
    // a step that called the service's own reset endpoint.
    const first = escalating[0]!;
    const where = tablesOf(escalating.filter((w) => w.code === first.code));
    reason = `${first.code}${where ? ` on ${where}` : ''}: ${first.bounds}`;
  } else if (noAssertions) {
    outcome = 'undecided';
    reason = 'this run evaluated no assertions, so it established nothing';
  } else {
    outcome = 'clean';
    // Under `--unevaluable warn` a clean run can hold assertions nobody decided.
    // The sentence used to say "4 assertions evaluated and passed" directly
    // above counts of 2 passed and 2 undecided — the one line an agent reads
    // first, claiming the opposite of the numbers under it. Found by running
    // the MCP server against a real service.
    const decided = assertions.total - assertions.unevaluable;
    reason =
      assertions.total === 0
        ? 'every step ran; nothing was asserted'
        : assertions.unevaluable > 0
          ? `${decided} of ${assertions.total} assertions evaluated and passed; ` +
            `${assertions.unevaluable} could not be evaluated and ` +
            `${assertions.unevaluable === 1 ? 'was' : 'were'} not counted against this run, by policy`
          : `${assertions.total} assertion${assertions.total === 1 ? '' : 's'} evaluated and passed`;
  }

  // What qualifies the verdict, whether or not it changed the outcome. A run
  // can be clean and still be worth reading the fine print on.
  const boundedBy: string[] = [];
  if (run.coverage === 'partial') {
    boundedBy.push(PARTIAL_BOUND);
  }
  if (unreached.length > 0) {
    // Stopping early is not the same as passing. The suite says nothing about
    // these steps, and a verdict that does not say so is claiming their silence
    // as agreement.
    boundedBy.push(
      `${unreached.length} step${unreached.length === 1 ? '' : 's'} never ran, so nothing here ` +
        `establishes anything about ${unreached.length === 1 ? 'it' : 'them'}: ${unreached.join(', ')}`,
    );
  }
  if (!baseline.probed) {
    boundedBy.push(UNPROBED_BOUND);
  }
  boundedBy.push(...warningBounds(warnings));
  if (policy.unevaluable === 'warn' && assertions.unevaluable > 0) {
    boundedBy.push(byPolicyBound(assertions.unevaluable));
  }
  if (assertions.total === 0 && steps.total > 0) {
    // Tells "saw and checked nothing" from "saw nothing".
    boundedBy.push(run.steps.some(observedStep) ? UNCHECKED_OBSERVED : UNCHECKED_UNOBSERVED);
  }

  return {
    outcome,
    reason,
    assertions,
    steps,
    coverage: run.coverage,
    proves: boundedBy.length === 0 ? 'full' : 'bounded',
    boundedBy,
    baseline,
    warnings,
    errors,
    durationMs: durationOf(run),
    policy,
  };
}

function durationOf(run: Run): number {
  if (!run.finishedAt) return 0;
  return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
}

/**
 * Folds many runs into one answer, using the same precedence.
 *
 * A suite is only as good as its worst member: one errored dataset makes the
 * suite errored, however many others were clean.
 */
export function mergeVerdicts(
  verdicts: ReadonlyArray<RunVerdict>,
  policy: VerdictPolicy = DEFAULT_POLICY,
): SuiteVerdict {
  const datasets: DatasetCounts = {
    total: verdicts.length,
    clean: 0,
    failed: 0,
    undecided: 0,
    errored: 0,
  };
  for (const verdict of verdicts) datasets[verdict.outcome]++;

  const sum = <K extends string>(pick: (v: RunVerdict) => Record<K, number>, keys: K[]) =>
    Object.fromEntries(
      keys.map((key) => [key, verdicts.reduce((total, v) => total + pick(v)[key], 0)]),
    ) as Record<K, number>;

  const assertions = sum((v) => v.assertions, [
    'total',
    'passed',
    'failed',
    'unevaluable',
    'passedAsRefused',
  ]);
  const steps = sum((v) => v.steps, [
    'total',
    'passed',
    'failed',
    'errored',
    'undecided',
    'notRun',
    'unchecked',
  ]);

  const worst: RunOutcome =
    datasets.errored > 0
      ? 'errored'
      : datasets.failed > 0
        ? 'failed'
        : datasets.undecided > 0
          ? 'undecided'
          : 'clean';

  const deciding = verdicts.find((v) => v.outcome === worst);
  const coverages = new Set(verdicts.map((v) => v.coverage));

  /**
   * The run-wide tail, counted across every dataset.
   *
   * This used to borrow `deciding.reason` — the *first* dataset that reached
   * the worst outcome — and paste it after a run-wide count. On the demo's own
   * `tuplescope run`, the first command the README asks anyone to type, that
   * produced two numbers about different things on adjacent lines:
   *
   *     outcome  clean · 2 of 2 datasets passed cleanly: 15 assertions …
   *     checks   23/23 passed
   *
   * `15` was one dataset's total. The JUnit file said 23 throughout, so only
   * the sentence a person reads was wrong.
   */
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const runTail =
    worst === 'clean'
      ? assertions.total === 0
        ? 'every step ran; nothing was asserted'
        : // The run-level sentence says this already; a suite of several
          // datasets said "5 assertions evaluated and passed" over 2 undecided.
          assertions.unevaluable > 0
          ? `${assertions.total - assertions.unevaluable} of ${plural(assertions.total, 'assertion')} ` +
            `evaluated and passed; ${assertions.unevaluable} could not be evaluated and ` +
            `${assertions.unevaluable === 1 ? 'was' : 'were'} not counted against this run, by policy`
          : `${plural(assertions.total, 'assertion')} evaluated and passed`
      : worst === 'failed'
        ? `${plural(assertions.failed, 'assertion')} failed`
        : worst === 'undecided'
          ? `${plural(assertions.unevaluable, 'assertion')} could not be evaluated`
          : // `errored` is about steps, not assertions: nothing was asserted
            // because the step never completed.
            `${plural(datasets.errored, 'dataset')} could not run`;

  return {
    outcome: worst,
    reason:
      verdicts.length === 0
        ? 'nothing ran'
        : datasets.total === 1
          ? (deciding?.reason ?? 'nothing ran')
          : `${datasets[worst]} of ${datasets.total} dataset${datasets.total === 1 ? '' : 's'} ` +
            `${worst === 'clean' ? 'passed cleanly' : worst}: ${runTail}`,
    assertions,
    steps,
    datasets,
    coverage: coverages.size > 1 ? 'mixed' : (verdicts[0]?.coverage ?? 'full'),
    proves: verdicts.some((v) => v.proves === 'bounded') ? 'bounded' : 'full',
    boundedBy: suiteBounds(verdicts, assertions),
    baseline: {
      probed: verdicts.every((v) => v.baseline.probed),
      windowMs: verdicts[0]?.baseline.windowMs ?? 0,
      clean: verdicts.every((v) => v.baseline.clean),
    },
    warnings: verdicts.flatMap((v) => v.warnings),
    errors: verdicts.flatMap((v) => v.errors),
    durationMs: verdicts.reduce((total, v) => total + v.durationMs, 0),
    policy,
  };
}

/**
 * What qualifies a suite, said about the suite.
 *
 * This was the set-union of every run's sentences, and a per-run sentence is
 * about one run. Measured through MCP `run_scenario` and the CLI envelope: two
 * datasets each with one undecided assertion under `--unevaluable warn` left
 * "1 undecided assertion was not counted against this run, by policy" beside
 * counts of 2 — the identical sentences collapsed into one. And a suite of
 * three datasets, two refused before sending and one that passed its only
 * assertion, said "no assertions were evaluated" over a checks line of 1/1.
 *
 * So a sentence that carries a count, or speaks for the whole run, is derived
 * again from the suite's own numbers. A sentence true of only some datasets
 * says how many. One that this function does not recognise — a newer
 * producer's, a hand-edited file's — is kept, with how many datasets said it,
 * because dropping a qualification is the direction this product cannot err in.
 */
function suiteBounds(verdicts: ReadonlyArray<RunVerdict>, assertions: AssertionCounts): string[] {
  const n = verdicts.length;
  // One dataset is the suite: its sentences are already about exactly this.
  if (n <= 1) return [...(verdicts[0]?.boundedBy ?? [])];

  const saying = (test: (bound: string) => boolean): number =>
    verdicts.filter((v) => v.boundedBy.some(test)).length;
  const share = (k: number): string => (k === n ? `in each of the ${n} datasets` : `in ${k} of ${n} datasets`);
  const perRunWarningBounds = new Set(verdicts.flatMap((v) => warningBounds(v.warnings)));
  const isUnchecked = (b: string): boolean => b === UNCHECKED_OBSERVED || b === UNCHECKED_UNOBSERVED;

  const out: string[] = [];
  for (const bound of new Set(verdicts.flatMap((v) => v.boundedBy))) {
    if (bound === PARTIAL_BOUND) {
      const k = saying((b) => b === bound);
      out.push(
        k === n
          ? bound
          : `${k} of ${n} datasets started mid-dataset, so earlier steps there left the database in ` +
              'whatever state the previous run did',
      );
    } else if (bound === UNPROBED_BOUND) {
      const k = saying((b) => b === bound);
      out.push(
        k === n
          ? bound
          : `the baseline was not probed ${share(k)}, so concurrent writes there would not have been detected`,
      );
    } else if (perRunWarningBounds.has(bound)) {
      // Regrouped over every dataset's warnings, so one kind is one line whose
      // tables are all of them.
      out.push(...warningBounds(verdicts.flatMap((v) => v.warnings)));
    } else if (BY_POLICY_BOUND.test(bound)) {
      out.push(
        byPolicyBound(
          verdicts
            .filter((v) => v.boundedBy.some((b) => BY_POLICY_BOUND.test(b)))
            .reduce((total, v) => total + v.assertions.unevaluable, 0),
        ),
      );
    } else if (isUnchecked(bound)) {
      if (assertions.total === 0) {
        out.push(saying((b) => b === UNCHECKED_OBSERVED) > 0 ? UNCHECKED_OBSERVED : UNCHECKED_UNOBSERVED);
      } else {
        const k = saying(isUnchecked);
        out.push(`${k} of ${n} datasets evaluated no assertions, so nothing in ${k === 1 ? 'it' : 'them'} was checked`);
      }
    } else {
      // Per-run and possibly count-bearing ("1 step never ran … : read"), so
      // said with how many datasets said it rather than as if of the suite.
      out.push(`${bound} (${share(saying((b) => b === bound))})`);
    }
  }
  return [...new Set(out)];
}

// ─── exit codes ───────────────────────────────────────────────────────────────

/**
 * The outcome-to-exit-code mapping, in Core because it is a contract.
 *
 * Only the codes a *run* can produce live here. A CLI adds its own for things
 * that happen before or outside a run — a bad flag, an empty selection, a
 * signal — and those are its business.
 *
 * `3` for undecided is the load-bearing choice. In CI nothing but the exit code
 * is consulted, so `0` would be the one place the product contradicts itself,
 * at the only interface that decides builds. `1` must keep meaning "open a bug
 * against the backend": a scenario that used to pass and now does not has
 * opposite owners depending on whether the endpoint regressed or somebody
 * narrowed the watch scope. `2` is spoken for by convention as "an error
 * occurred".
 */
export const EXIT_CODE: Readonly<Record<RunOutcome, number>> = {
  clean: 0,
  failed: 1,
  errored: 2,
  undecided: 3,
};

export function exitCodeOf(outcome: RunOutcome): number {
  return EXIT_CODE[outcome];
}

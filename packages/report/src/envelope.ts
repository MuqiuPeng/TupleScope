/**
 * The machine-readable shape of a run.
 *
 * One envelope serves `--json`, the stored run history and (in v0.3) MCP, so
 * the versioning rules below are a contract, not a convention.
 *
 * The rule that makes the open enums safe is the product's central principle
 * applied to the wire format: **an unknown value degrades to undecided, never
 * to passed.** A consumer meeting an `assertion.outcome` it does not recognise
 * counts it as unevaluable; one meeting an unknown `warning.code` escalates it.
 * That is not hypothetical — `scope-truncated` and `reduced-fidelity` are
 * declared today and emitted by nothing, so the next capture engine is exactly
 * the change that would otherwise ship a silent green into somebody's CI.
 */

import { keyLabel } from '@tuplescope/core';
import type {
  AssertionCandidate,
  AssertionResult,
  CaptureMethod,
  ChangeSet,
  Detection,
  Fidelity,
  ExecutionError,
  LocatedWarning,
  Proves,
  Run,
  RunOutcome,
  RunVerdict,
  StepOutcome,
  SuiteVerdict,
  VerdictPolicy,
} from '@tuplescope/core';

/** Bumped on removal, rename, or a semantic change. Never on an added field. */
import { RUN_REPORT_SCHEMA } from '@tuplescope/core';
export { RUN_REPORT_SCHEMA } from '@tuplescope/core';

export type SchemaId = typeof RUN_REPORT_SCHEMA;

export interface Producer {
  tool: 'tuplescope';
  version: string;
  /** Which consumer produced this. Two surfaces, one shape. */
  surface: 'cli' | 'runtime' | 'mcp';
}

export interface WorkspaceSummary {
  name: string;
  configPath: string;
  baseUrl: string;
  scenariosDir: string;
  capture: { method: CaptureMethod; detection: Detection; fidelity: Fidelity };
  tableCount: number;
}

export interface Invocation {
  argv: ReadonlyArray<string>;
  targets: ReadonlyArray<string>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface PolicyReport extends VerdictPolicy {
  /** Resolved from the policy, so a reader need not re-derive the table. */
  escalatedCodes: ReadonlyArray<string>;
  baselineWindowMs: number;
  exitZero: boolean;
}

export interface AssertionReport {
  source: string;
  /** Open enum. An unrecognised value must be read as `unevaluable`. */
  outcome: AssertionResult['status'];
  actual?: string;
  expected?: string;
  reason?: string;
}

export interface StepReport {
  id: string;
  name: string;
  /** Open enum. An unrecognised value must be read as `undecided`. */
  outcome: StepOutcome;
  /** The engine's own status, kept distinct from the verdict's reading of it. */
  engineStatus: string;
  request: { method: string; url: string; as?: string };
  response?: { status: number; durationMs: number };
  assertions: ReadonlyArray<AssertionReport>;
  changes?: ChangeSummary;
  error?: ExecutionError;
  /**
   * Assertions this step's own changes imply, ready to be kept.
   *
   * Carried in the envelope so `tuplescope keep` can work on a run that already
   * finished. Promoting only what is still in memory would mean the loop only
   * closes if you noticed in the same breath as the run.
   */
  candidates?: ReadonlyArray<AssertionCandidate>;
  durationMs: number;
}

/**
 * A ChangeSet reduced to counts, plus the rows when asked for.
 *
 * `writtenNoVisibleChange` is called out separately because it is the product's
 * whole differentiator and would otherwise vanish into a zero.
 */
export interface ChangeSummary {
  method: CaptureMethod;
  detection: Detection;
  fidelity: Fidelity;
  /**
   * The order writes happened in, present only when the engine kept it.
   *
   * Absent is a fact, not a gap: a consumer reading this file learns that the
   * ordering was never observed, rather than that it happened to be empty. The
   * counts are the summary a report wants; the full list is under `rows`.
   */
  writeOrder?: {
    total: number;
    transactions: number;
    /** Writes to rows that are not in the net view — written, then removed. */
    withoutNetChange: number;
    /** `table:operation:key`, in order. Only with full rows. */
    sequence?: ReadonlyArray<string>;
  };
  /**
   * Where the tables below live, not just how many there are.
   *
   * A `RowChange` carries a bare table name, and a bare table name only means
   * something inside the connection that produced it. Anything reading this
   * file later — a second tool, a database UI, a person writing a SELECT — has
   * no other way to know which schema in which database was watched. Measured
   * on two schemas in one database: a statement generated against `tenant_a`
   * returned `tenant_b`'s row, different balance, no error.
   */
  scope: { schema: string; database: string; allTables: boolean; tableCount: number };
  /**
   * The session settings this run's text was rendered under.
   *
   * Carried so a consumer building a statement from a stored run can check
   * rather than trust. A `timestamptz` printed under `DateStyle=SQL,DMY`
   * addresses a different row than the same value printed under `ISO`, and by
   * the time a report is on disk there is nothing left to ask.
   */
  rendering: Readonly<Record<string, string>>;
  durationMs: number;
  tables: ReadonlyArray<{
    table: string;
    inserted: number;
    updated: number;
    deleted: number;
    writtenNoVisibleChange: number;
  }>;
  warnings: ReadonlyArray<LocatedWarning | { code: string; message: string; table?: string }>;
  /** Present only when the caller asked for full rows. */
  rows?: ReadonlyArray<unknown>;
}

export interface RunReport {
  selector: string;
  scenario: { id: string; title: string; file: string };
  dataset: { id: string; label: string };
  verdict: RunVerdict;
  run: {
    id: string;
    coverage: Run['coverage'];
    engineStatus: string;
    startedAt: string;
    finishedAt?: string;
    baseline: { probed: boolean; windowMs: number };
    variables: Readonly<Record<string, string>>;
    baselineNoise?: ChangeSummary;
  };
  steps: ReadonlyArray<StepReport>;
}

export interface Envelope {
  schema: SchemaId;
  producer: Producer;
  generatedAt: string;
  workspace: WorkspaceSummary;
  invocation: Invocation;
  policy: PolicyReport;
  outcome: RunOutcome;
  exitCode: number;
  proves: Proves;
  boundedBy: ReadonlyArray<string>;
  totals: {
    runs: number;
    datasets: SuiteVerdict['datasets'];
    steps: SuiteVerdict['steps'];
    assertions: SuiteVerdict['assertions'];
    warnings: { total: number; escalated: number };
  };
  runs: ReadonlyArray<RunReport>;
}

// ─── reading an envelope defensively ──────────────────────────────────────────

const KNOWN_ASSERTION_OUTCOMES = new Set([
  'passed',
  'failed',
  'passed-as-refused',
  'unevaluable',
]);

/**
 * How a consumer must read `assertion.outcome` from an envelope it did not
 * produce: anything it does not recognise is undecided.
 *
 * Exported rather than left to each reader, because "default to passed" is the
 * mistake this whole format is arranged to prevent, and a reader writing its
 * own switch is a reader who will get it wrong once.
 */
export function readAssertionOutcome(value: string): AssertionResult['status'] {
  return KNOWN_ASSERTION_OUTCOMES.has(value)
    ? (value as AssertionResult['status'])
    : 'unevaluable';
}

const KNOWN_STEP_OUTCOMES = new Set(['passed', 'failed', 'errored', 'undecided', 'not-run']);

export function readStepOutcome(value: string): StepOutcome {
  return KNOWN_STEP_OUTCOMES.has(value) ? (value as StepOutcome) : 'undecided';
}

// ─── building one ─────────────────────────────────────────────────────────────

/** Folds a ChangeSet into counts without carrying every value. */
export function summariseChanges(changes: ChangeSet, includeRows = false): ChangeSummary {
  const byTable = new Map<string, ChangeSummary['tables'][number]>();
  for (const change of changes.changes) {
    let entry = byTable.get(change.table);
    if (!entry) {
      entry = {
        table: change.table,
        inserted: 0,
        updated: 0,
        deleted: 0,
        writtenNoVisibleChange: 0,
      };
      byTable.set(change.table, entry);
    }
    if (change.kind === 'insert' || change.kind === 'entered-scope') entry.inserted++;
    else if (change.kind === 'delete' || change.kind === 'left-scope') entry.deleted++;
    // A row nothing wrote is not an update. It cannot reach a ChangeSet today,
    // and the `else` below would otherwise silently call it one.
    else if (change.kind === 'unchanged') continue;
    else {
      entry.updated++;
      // The case a value comparison cannot see. Counted separately so it cannot
      // be mistaken for nothing having happened.
      if (change.visibleColumns.length === 0) entry.writtenNoVisibleChange++;
    }
  }

  return {
    method: changes.captureMethod,
    detection: changes.detection,
    fidelity: changes.fidelity,
    scope: {
      schema: changes.scope.schema,
      database: changes.scope.database,
      allTables: changes.scope.allTables,
      tableCount: changes.scope.tables.length,
    },
    rendering: changes.rendering,
    durationMs: changes.durationMs,
    tables: [...byTable.values()].sort((a, b) => a.table.localeCompare(b.table)),
    warnings: changes.warnings,
    ...(changes.mutations ? { writeOrder: summariseWriteOrder(changes, includeRows) } : {}),
    ...(includeRows ? { rows: changes.changes } : {}),
  };
}

function summariseWriteOrder(
  changes: ChangeSet,
  includeSequence: boolean,
): NonNullable<ChangeSummary['writeOrder']> {
  const mutations = changes.mutations ?? [];
  // On the per-run token, not on the reported key text: under a masked key
  // column every row of a table shared that text, so every mutation joined
  // against the first change and `withoutNetChange` came out zero.
  const inNetView = new Set(changes.changes.map((c) => `${c.table}\u0000${c.key?.token ?? ''}`));
  const identify = (m: (typeof mutations)[number]) => `${m.table}\u0000${m.key?.token ?? ''}`;
  return {
    total: mutations.length,
    transactions: new Set(mutations.map((m) => m.transactionId)).size,
    withoutNetChange: mutations.filter((m) => !inNetView.has(identify(m))).length,
    ...(includeSequence
      ? {
          sequence: mutations.map(
            (m) =>
              `${m.table}:${m.operation}:${keyLabel(m.key)}`,
          ),
        }
      : {}),
  };
}

export interface BuildOptions {
  producer: Producer;
  workspace: WorkspaceSummary;
  invocation: Invocation;
  policy: PolicyReport;
  exitCode: number;
  /** Whole rows in the envelope, not just counts. */
  includeRows?: boolean;
  now?: () => Date;
}

/**
 * The steps a run declared and never reached, as reports of their own.
 *
 * A dataset that halts on step 2 of 5 produced a JUnit file reading
 * `tests="2" skipped="0"` — a CI system saw a suite of two, one failing, with
 * nothing to say three more had been declared. `mapStep` has understood
 * `not-run` all along; the steps simply were not there to map, because the
 * envelope walked what executed rather than what was asked for.
 *
 * Deliberately thin: no request, no response, no assertions. There is nothing
 * to report about them beyond their existence, and inventing more would be the
 * overclaiming this exists to stop.
 */
function unreachedSteps(run: Run): StepReport[] {
  const attempted = new Set(run.steps.map((step) => step.stepId));
  return (run.declaredSteps ?? [])
    .filter((id) => !attempted.has(id))
    .map((id) => ({
      id,
      name: id,
      outcome: 'not-run' as const,
      engineStatus: 'pending' as const,
      request: { method: '', url: '' },
      assertions: [],
      durationMs: 0,
    }));
}

export function buildEnvelope(
  reports: ReadonlyArray<{
    selector: string;
    scenario: { id: string; title: string; file: string };
    dataset: { id: string; label: string };
    run: Run;
    verdict: RunVerdict;
  }>,
  suite: SuiteVerdict,
  options: BuildOptions,
): Envelope {
  const now = options.now ?? (() => new Date());
  const warnings = reports.flatMap((r) => r.verdict.warnings);

  return {
    schema: RUN_REPORT_SCHEMA,
    producer: options.producer,
    generatedAt: now().toISOString(),
    workspace: options.workspace,
    invocation: options.invocation,
    policy: options.policy,
    outcome: suite.outcome,
    exitCode: options.exitCode,
    proves: suite.proves,
    boundedBy: suite.boundedBy,
    totals: {
      runs: reports.length,
      datasets: suite.datasets,
      steps: suite.steps,
      assertions: suite.assertions,
      warnings: {
        total: warnings.length,
        escalated: warnings.filter((w) => w.severity === 'error').length,
      },
    },
    runs: reports.map(({ selector, scenario, dataset, run, verdict }) => ({
      selector,
      scenario,
      dataset,
      verdict,
      run: {
        id: run.id,
        coverage: run.coverage,
        engineStatus: run.status,
        startedAt: run.startedAt,
        ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
        baseline: run.baseline,
        variables: run.variables,
        ...(run.baselineNoise
          ? { baselineNoise: summariseChanges(run.baselineNoise, options.includeRows ?? false) }
          : {}),
      },
      steps: run.steps.map((step): StepReport => ({
        id: step.stepId,
        name: step.name,
        outcome: outcomeFor(step, verdict),
        engineStatus: step.status,
        request: {
          method: step.request.method,
          url: step.request.url,
          ...(step.request.as !== undefined ? { as: step.request.as } : {}),
        },
        ...(step.response
          ? { response: { status: step.response.status, durationMs: step.response.durationMs } }
          : {}),
        assertions: step.assertions.map((assertion) => ({
          source: assertion.source,
          outcome: assertion.status,
          ...(assertion.actual !== undefined ? { actual: assertion.actual } : {}),
          ...(assertion.expected !== undefined ? { expected: assertion.expected } : {}),
          ...(assertion.reason !== undefined ? { reason: assertion.reason } : {}),
        })),
        ...(step.changes
          ? { changes: summariseChanges(step.changes, options.includeRows ?? false) }
          : {}),
        ...(step.error !== undefined ? { error: step.error } : {}),
        ...(step.candidates?.length ? { candidates: step.candidates } : {}),
        durationMs: stepDuration(step),
      })).concat(unreachedSteps(run)),
    })),
  };
}

function outcomeFor(
  step: Run['steps'][number],
  verdict: RunVerdict,
): StepOutcome {
  // Re-derived through the same policy the verdict used, so a step can never
  // read as passed inside a run the same policy called undecided.
  if (step.status === 'errored') return 'errored';
  if (step.status === 'skipped' || step.status === 'pending') return 'not-run';
  if (step.status === 'failed' || step.assertions.some((a) => a.status === 'failed')) return 'failed';
  if (
    verdict.policy.unevaluable === 'error' &&
    step.assertions.some((a) => a.status === 'unevaluable')
  ) {
    return 'undecided';
  }
  return 'passed';
}

function stepDuration(step: Run['steps'][number]): number {
  if (!step.finishedAt) return 0;
  return Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt));
}

export type { ExecutionError };

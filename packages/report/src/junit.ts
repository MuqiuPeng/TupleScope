/**
 * JUnit XML, for the CI dashboards that will never read anything else.
 *
 * The whole file turns on one decision: an undecided assertion is `<error>`,
 * never `<skipped>` and never a bare passing testcase.
 *
 * `<skipped>` is the intuitive choice and it is wrong in practice — every
 * consumer surveyed renders it green or hides it, and NUnit's own converter
 * turns `Inconclusive`, the closest existing concept to ours, into an
 * indistinguishable pass. `<failure>` goes red for the wrong reason and sends
 * the reader to debug an API when the remedy is to narrow a `single()`.
 * `<error>` is the only element that already means *no verdict was reached*
 * everywhere, and every consumer counts it as bad. The `type` attribute
 * follows pytest's `type="pytest.skip"` convention, so a TupleScope-aware
 * reader recovers the exact status and a naive one still sees a problem.
 *
 * The mapping below is a table rather than a switch because it is also what
 * decides the exit contribution. Deriving both from one source is what makes
 * "green in the XML, non-zero at the shell" unrepresentable — see the
 * consistency test.
 */

import type { RunOutcome, VerdictPolicy } from '@tuplescope/core';
import type { AssertionReport, Envelope, RunReport, StepReport } from './envelope.js';

/** What a single result becomes in the XML, and what it costs the exit code. */
export interface Mapping {
  /** `null` renders a bare, passing `<testcase/>`. */
  element: 'failure' | 'error' | 'skipped' | null;
  type?: string;
  /** The worst outcome this result can force. `clean` contributes nothing. */
  contributes: RunOutcome;
}

const PASS: Mapping = { element: null, contributes: 'clean' };

export function mapAssertion(
  assertion: AssertionReport,
  policy: VerdictPolicy,
): Mapping {
  switch (assertion.outcome) {
    case 'passed':
    case 'passed-as-refused':
      return PASS;
    case 'failed':
      return { element: 'failure', type: 'tuplescope.assertion', contributes: 'failed' };
    case 'unevaluable':
      // Under `--unevaluable=warn` the operator has declared they accept this,
      // so it drops to skipped and contributes nothing — but it is still in the
      // file, still typed, still countable.
      return policy.unevaluable === 'error'
        ? { element: 'error', type: 'tuplescope.unevaluable', contributes: 'undecided' }
        : { element: 'skipped', type: 'tuplescope.unevaluable', contributes: 'clean' };
    default:
      // An outcome from a newer producer. Degrade to undecided, never to passed.
      return { element: 'error', type: 'tuplescope.unevaluable', contributes: 'undecided' };
  }
}

export function mapStep(step: StepReport): Mapping | null {
  if (step.outcome === 'errored') {
    return {
      element: 'error',
      type: `tuplescope.${step.error?.kind ?? 'unknown'}`,
      contributes: 'errored',
    };
  }
  if (step.outcome === 'not-run') {
    // Genuinely not run, by the runner's own decision. This is the one case
    // where `skipped` means what CI thinks it means.
    return { element: 'skipped', type: 'tuplescope.not-run', contributes: 'clean' };
  }
  return null;
}

export function mapWarning(severity: 'error' | 'warn'): Mapping {
  return severity === 'error'
    ? { element: 'error', type: 'tuplescope.capture-warning', contributes: 'undecided' }
    : PASS;
}

// ─── XML ──────────────────────────────────────────────────────────────────────

/**
 * Escapes text for XML, including the characters only attributes need.
 *
 * Assertion sources are full of them — `single(updated(payments)).after.status
 * == "REFUNDED"` carries quotes, `a < b` carries an angle bracket — and an
 * unescaped one produces a file no CI parser will read, which reads to the user
 * as TupleScope having produced no report at all.
 */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 even escaped; a database value
    // can contain them, and one would otherwise poison the whole file.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

function attrs(pairs: Array<[string, string | number | undefined]>): string {
  return pairs
    .filter((pair): pair is [string, string | number] => pair[1] !== undefined)
    .map(([key, value]) => `${key}="${xml(String(value))}"`)
    .join(' ');
}

interface Case {
  classname: string;
  name: string;
  timeMs: number;
  mapping: Mapping;
  message?: string;
  detail?: string;
}

function renderCase(testcase: Case, indent: string): string {
  const head = `${indent}<testcase ${attrs([
    ['classname', testcase.classname],
    ['name', testcase.name],
    ['time', seconds(testcase.timeMs)],
  ])}`;
  if (!testcase.mapping.element) return `${head}/>`;

  const inner = `${indent}  <${testcase.mapping.element} ${attrs([
    ['type', testcase.mapping.type],
    ['message', testcase.message],
  ])}>`;
  const body = testcase.detail ? `\n${xml(testcase.detail)}\n${indent}  ` : '';
  return `${head}>\n${inner}${body}</${testcase.mapping.element}>\n${indent}</testcase>`;
}

/**
 * Why an assertion did not decide, spelled out.
 *
 * `<error message>` is often all a dashboard shows, so it has to carry the
 * distinction on its own: the body says outright that this is neither a pass
 * nor a failure, because a reader who has only ever seen the two will
 * otherwise file it as one of them.
 */
function detailFor(assertion: AssertionReport): { message: string; detail: string } | undefined {
  if (assertion.outcome === 'failed') {
    return {
      message: `expected ${assertion.expected ?? '(unstated)'}, got ${assertion.actual ?? '(nothing)'}`,
      detail:
        `${assertion.source}\n\n` +
        `expected  ${assertion.expected ?? '(unstated)'}\n` +
        `actual    ${assertion.actual ?? '(nothing)'}`,
    };
  }
  if (assertion.outcome !== 'passed' && assertion.outcome !== 'passed-as-refused') {
    return {
      message: `could not be evaluated: ${assertion.reason ?? 'no reason recorded'}`,
      detail:
        `${assertion.source}\n\n` +
        `status  unevaluable — this assertion did NOT run. It is neither a pass nor a failure.\n` +
        `reason  ${assertion.reason ?? 'no reason recorded'}\n\n` +
        `Nothing here says the system under test is wrong. It says this check did not happen,\n` +
        `so the run did not establish what it claims to.`,
    };
  }
  return undefined;
}

function casesForRun(report: RunReport, policy: VerdictPolicy): Case[] {
  const suite = `${report.scenario.id} · ${report.dataset.id}`;
  const out: Case[] = [];

  for (const step of report.steps) {
    const classname = `${suite} · ${step.id}`;
    const stepMapping = mapStep(step);
    if (stepMapping) {
      out.push({
        classname,
        name: step.name,
        timeMs: step.durationMs,
        mapping: stepMapping,
        ...(step.error
          ? {
              message: step.error.message,
              detail: step.error.remedy
                ? `${step.error.message}\n\nremedy  ${step.error.remedy}`
                : step.error.message,
            }
          : { message: 'not reached' }),
      });
      continue;
    }

    if (step.assertions.length === 0) {
      // Visible as a testcase rather than absent: a step that checked nothing
      // is a fact about the suite, and an empty suite reads as a passing one.
      out.push({
        classname,
        name: `${step.name} (no assertions)`,
        timeMs: step.durationMs,
        mapping: PASS,
      });
      continue;
    }

    step.assertions.forEach((assertion, index) => {
      const extra = detailFor(assertion);
      out.push({
        classname,
        name: assertion.source,
        // The step's wall clock lands on its first assertion and the rest are
        // zero, so the total stays true without inventing per-assertion timings.
        timeMs: index === 0 ? step.durationMs : 0,
        mapping: mapAssertion(assertion, policy),
        ...(extra ?? {}),
      });
    });
  }

  // Capture warnings get their own cases so that a run bounded by one shows up
  // in a dashboard that only ever renders testcases — one per step and code,
  // naming its tables. It was one per table: a step that truncated 35 tables
  // came out as errors="35", thirty-five things wrong where one thing
  // happened, which is also how the verdict's `boundedBy` came to be grouped.
  // Every table's own message stays in the body.
  const groups = new Map<string, Array<(typeof report.verdict.warnings)[number]>>();
  for (const warning of report.verdict.warnings) {
    const where = warning.source === 'baseline' ? 'baseline' : (warning.stepId ?? 'step');
    const id = `${where} ${warning.code}`;
    groups.set(id, [...(groups.get(id) ?? []), warning]);
  }
  for (const same of groups.values()) {
    const first = same[0]!;
    const where = first.source === 'baseline' ? 'baseline' : (first.stepId ?? 'step');
    const tables = [...new Set(same.flatMap((w) => (w.table ? [w.table] : [])))];
    out.push({
      classname: `${suite} · ${where} · capture`,
      name: `${first.code}${tables.length > 0 ? ` (${capped(tables)})` : ''}`,
      timeMs: 0,
      mapping: mapWarning(same.some((w) => w.severity === 'error') ? 'error' : 'warn'),
      message:
        same.length === 1
          ? first.message
          : `${first.bounds}${tables.length > 0 ? ` (${capped(tables)})` : ''}`,
      detail: `${same.map((w) => w.message).join('\n')}\n\nbounds  ${first.bounds}`,
    });
  }

  return out;
}

/** `accounts, addresses, blocks and 32 more` — the verdict's wording: names, capped, never only a count. */
function capped(names: ReadonlyArray<string>): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

export interface JUnitOptions {
  /** Shown as the suite hostname. The workspace is the closest true analogue. */
  hostname?: string;
  timestamp?: string;
}

export function toJUnit(envelope: Envelope, options: JUnitOptions = {}): string {
  const policy = envelope.policy;
  const suites = envelope.runs.map((report) => {
    const cases = casesForRun(report, policy);
    const count = (element: Mapping['element']) =>
      cases.filter((c) => c.mapping.element === element).length;

    const body = cases.map((testcase) => renderCase(testcase, '    ')).join('\n');
    const { total: declared, notRun } = report.verdict.steps;
    const properties = [
      ['tuplescope.schema', envelope.schema],
      ['tuplescope.runId', report.run.id],
      ['tuplescope.scenario', report.scenario.id],
      ['tuplescope.dataset', report.dataset.id],
      ['tuplescope.file', report.scenario.file],
      ['tuplescope.outcome', report.verdict.outcome],
      // Where the run started: `full` from the first step, `partial` from
      // `--from`/`--only`. It is not whether every step ran — a run that halted
      // with 2 of 4 steps unreached still says `full` here, which read as a
      // claim of completeness (ts-verify re-honesty-runtime, notrun). Kept for
      // the consumers that read it; how far the run got is `reach`.
      ['tuplescope.coverage', report.verdict.coverage],
      ['tuplescope.reach', `${declared - notRun}/${declared} steps ran`],
      ['tuplescope.proves', report.verdict.proves],
      ['tuplescope.captureMethod', envelope.workspace.capture.method],
      ['tuplescope.detection', envelope.workspace.capture.detection],
      [
        'tuplescope.baseline',
        report.run.baseline.probed ? `probed:${report.run.baseline.windowMs}ms` : 'not-probed',
      ],
      ['tuplescope.unevaluable', String(report.verdict.assertions.unevaluable)],
    ]
      .map(([name, value]) => `      <property ${attrs([['name', name], ['value', value]])}/>`)
      .join('\n');

    const durationMs = report.steps.reduce((total, step) => total + step.durationMs, 0);

    return (
      `  <testsuite ${attrs([
        ['name', `${report.scenario.id} · ${report.dataset.id}`],
        ['hostname', options.hostname ?? envelope.workspace.name],
        ['timestamp', options.timestamp ?? report.run.startedAt],
        ['tests', cases.length],
        ['failures', count('failure')],
        ['errors', count('error')],
        ['skipped', count('skipped')],
        ['time', seconds(durationMs)],
      ])}>\n` +
      `    <properties>\n${properties}\n    </properties>\n` +
      `${body}\n` +
      `  </testsuite>`
    );
  });

  const all = envelope.runs.flatMap((report) => casesForRun(report, policy));
  const total = (element: Mapping['element']) =>
    all.filter((c) => c.mapping.element === element).length;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites ${attrs([
      ['name', 'tuplescope'],
      ['tests', all.length],
      ['failures', total('failure')],
      ['errors', total('error')],
      ['skipped', total('skipped')],
      ['time', seconds(envelope.invocation.durationMs)],
    ])}>\n` +
    `${suites.join('\n')}\n` +
    `</testsuites>\n`
  );
}

/**
 * The worst outcome the XML claims, derived from the same table that produced it.
 *
 * Exists so a test can assert the two can never disagree: if this says
 * `undecided`, the exit code is 3, and the file contains an `<error>` — one
 * cannot be changed without the others.
 */
export function outcomeFromCases(envelope: Envelope): RunOutcome {
  const order: RunOutcome[] = ['clean', 'undecided', 'failed', 'errored'];
  let worst: RunOutcome = 'clean';
  for (const report of envelope.runs) {
    for (const testcase of casesForRun(report, envelope.policy)) {
      if (order.indexOf(testcase.mapping.contributes) > order.indexOf(worst)) {
        worst = testcase.mapping.contributes;
      }
    }
  }
  return worst;
}

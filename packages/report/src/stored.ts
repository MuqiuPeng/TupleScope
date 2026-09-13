/**
 * A stored run, read back as the one-run envelope it was saved from.
 *
 * `.tuplescope/runs/*.json` holds one `RunReport` with the envelope's header —
 * schema, producer, workspace, policy — spread over it, so that a stored run is
 * not a second on-disk format. `tuplescope report` gated on the schema id,
 * which a stored run shares, and then read `runs` off it, which a stored run
 * does not have: `flatMap` produced a list of one `undefined`, and the crash
 * named `.selector` rather than the file. Found on the first real install, by
 * someone doing the obvious thing with the files the tool had just written.
 *
 * Everything an envelope needs is on the stored run or follows from its
 * verdict. The one thing that is not is the invocation: a stored run does not
 * record the command line it came from, and this does not invent one — `argv`
 * is empty and `targets` is the run's own selector.
 */

import { exitCodeOf, mergeVerdicts } from '@tuplescope/core';
import type { Envelope, PolicyReport, Producer, RunReport, WorkspaceSummary } from './envelope.js';

export interface StoredRunReport extends RunReport {
  schema: Envelope['schema'];
  producer: Producer;
  workspace: WorkspaceSummary;
  policy: PolicyReport;
}

/** A stored run rather than an envelope: one report, with no `runs` list. */
export function isStoredRun(value: unknown): value is StoredRunReport {
  if (!value || typeof value !== 'object') return false;
  const v = value as { selector?: unknown; steps?: unknown; runs?: unknown; verdict?: unknown };
  return (
    typeof v.selector === 'string' &&
    Array.isArray(v.steps) &&
    !!v.verdict &&
    !Array.isArray(v.runs)
  );
}

export function envelopeOfStoredRun(
  stored: StoredRunReport,
  now: () => Date = () => new Date(),
): Envelope {
  const { schema, producer, workspace, policy, ...report } = stored;
  const suite = mergeVerdicts([report.verdict], policy);
  const natural = exitCodeOf(suite.outcome);
  const startedAt = report.run.startedAt;
  const finishedAt = report.run.finishedAt ?? startedAt;
  return {
    schema,
    producer,
    generatedAt: now().toISOString(),
    workspace,
    invocation: {
      argv: [],
      targets: [report.selector],
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    },
    policy,
    outcome: suite.outcome,
    // The same cap the run applied, read from the policy it stored — so a run
    // saved under --exit-zero reports the exit code it actually returned.
    exitCode: policy.exitZero && (natural === 1 || natural === 3) ? 0 : natural,
    proves: suite.proves,
    boundedBy: suite.boundedBy,
    totals: {
      runs: 1,
      datasets: suite.datasets,
      steps: suite.steps,
      assertions: suite.assertions,
      warnings: {
        total: report.verdict.warnings.length,
        escalated: report.verdict.warnings.filter((w) => w.severity === 'error').length,
      },
    },
    runs: [report],
  };
}

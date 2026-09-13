/**
 * Several stored envelopes folded into one, for `tuplescope report a.json b.json`.
 *
 * The CLI used to do this inline by spreading the first file and overwriting a
 * few fields, and everything it did not overwrite was the first file's alone.
 * Measured on two real envelopes, one clean and one failed: the merged `--json`
 * listed two runs, a failed outcome and 34 assertions with one failure, while
 * its own `totals` said one run, no failed dataset and 29 assertions — so a
 * dashboard summing `totals` saw a clean suite. `invocation.targets` named the
 * first file's selector only.
 *
 * And the exit code was the numeric maximum of the inputs while the outcome
 * was the worst by precedence. `failed` (1) merged with `undecided` (3) said
 * `outcome failed` and exited 3 — "nothing failed", in the one field CI reads.
 * Here the exit code is derived from the merged outcome by the same table a run
 * uses, so the two cannot disagree.
 *
 * Everything that describes the runs is recomputed from the runs themselves,
 * with `mergeVerdicts`, the function a live suite is judged by.
 */

import { exitCodeOf, mergeVerdicts, type RunOutcome } from '@tuplescope/core';
import type { Envelope } from './envelope.js';

/** Worst first — the order `mergeVerdicts` uses for a suite. */
const PRECEDENCE: ReadonlyArray<RunOutcome> = ['errored', 'failed', 'undecided', 'clean'];

export function mergeEnvelopes(
  envelopes: ReadonlyArray<Envelope>,
  now: () => Date = () => new Date(),
): Envelope {
  const first = envelopes[0];
  if (!first) throw new Error('mergeEnvelopes needs at least one envelope');

  const runs = envelopes.flatMap((envelope) => envelope.runs);
  const suite = mergeVerdicts(
    runs.map((report) => report.verdict),
    first.policy,
  );
  // The worst of what the runs say and what each file says about itself. They
  // agree for anything this tool wrote; where a hand-edited file does not, the
  // worse reading wins, because the better one is the overclaim.
  const outcome = PRECEDENCE.find(
    (candidate) =>
      suite.outcome === candidate || envelopes.some((envelope) => envelope.outcome === candidate),
  )!;

  // `--exit-zero` is a decision somebody made about their own run. The cap is
  // kept only when every input was stored under it: one input without it and
  // the merge reports the natural code, because a cap chosen for one shard is
  // not a decision about another shard's result. Even capped, only 1 and 3 are
  // — the same rule the run applies, and `policy.exitZero` records that it did.
  const exitZero = envelopes.every((envelope) => envelope.policy?.exitZero === true);
  const natural = exitCodeOf(outcome);
  const exitCode = exitZero && (natural === 1 || natural === 3) ? 0 : natural;

  const warnings = runs.flatMap((report) => report.verdict.warnings);
  const single = envelopes.length === 1;
  const started = envelopes.map((envelope) => envelope.invocation.startedAt).sort();
  const finished = envelopes.map((envelope) => envelope.invocation.finishedAt).sort();

  return {
    ...first,
    generatedAt: single ? first.generatedAt : now().toISOString(),
    // One file keeps its own command line. Several have no single one, and this
    // does not invent it: `argv` is empty, the targets are every file's, and
    // the duration is the time spent in them — summed, like the verdict's —
    // rather than a span that would count the gap between two shards run a day
    // apart.
    invocation: single
      ? first.invocation
      : {
          argv: [],
          targets: [...new Set(envelopes.flatMap((envelope) => envelope.invocation.targets))],
          startedAt: started[0]!,
          finishedAt: finished[finished.length - 1]!,
          durationMs: envelopes.reduce((total, envelope) => total + envelope.invocation.durationMs, 0),
        },
    policy: {
      ...first.policy,
      escalatedCodes: [...new Set(envelopes.flatMap((envelope) => envelope.policy.escalatedCodes))],
      exitZero,
    },
    outcome,
    exitCode,
    proves:
      suite.proves === 'bounded' || envelopes.some((envelope) => envelope.proves === 'bounded')
        ? 'bounded'
        : 'full',
    // The suite's own sentences first, derived from every run. A file's own
    // `boundedBy` is its runs' suite, so it is re-derived above; adding it back
    // put "1 undecided assertion was not counted" from each of two shards beside
    // the merged "2 … were". Only what a file says that its runs do not — a
    // hand-edited or newer producer's line — is carried over.
    boundedBy: [
      ...new Set([
        ...suite.boundedBy,
        ...envelopes.flatMap((envelope) => {
          const derived = new Set([
            ...envelope.runs.flatMap((report) => report.verdict.boundedBy),
            ...mergeVerdicts(
              envelope.runs.map((report) => report.verdict),
              envelope.policy,
            ).boundedBy,
          ]);
          return envelope.boundedBy.filter((bound) => !derived.has(bound));
        }),
      ]),
    ],
    totals: {
      runs: runs.length,
      datasets: suite.datasets,
      steps: suite.steps,
      assertions: suite.assertions,
      warnings: {
        total: warnings.length,
        escalated: warnings.filter((warning) => warning.severity === 'error').length,
      },
    },
    runs,
  };
}

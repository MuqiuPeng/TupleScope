/**
 * What the coloured dot says, and where it comes from.
 *
 * It comes from the run. It is not worked out here.
 *
 * The page used to derive its own verdict from assertion statuses alone, which
 * made it a second implementation of the one judgement this product exists to
 * make — and the two disagreed. A run where every assertion passed but the
 * capture reported `scope-truncated` came back `clean` here and `undecided`
 * from `verdictOf`, so the page showed a green dot over a run `tuplescope run`
 * exits 3 on. The page's rule never looked at warnings at all.
 *
 * So the rule is now: read the verdict the runtime computed with the same
 * function the CLI and the exit code use, and if it is not there, say so rather
 * than guess. An old stored run has no verdict on it, and inventing one from
 * what is visible would recreate exactly the bug this replaced.
 */

/** The four outcomes, plus the one that means "this payload did not say". */
const UNKNOWN = 'unknown';

function runVerdict(run) {
  return run?.verdict?.outcome ?? UNKNOWN;
}

/**
 * One step's outcome, likewise from the run.
 *
 * `outcomeOfStep` says `passed`; the page's palette and labels say `clean`. The
 * words are translated here rather than at each use, so there is one place
 * where the two vocabularies meet.
 */
function stepVerdict(step) {
  const outcome = step?.outcome;
  if (outcome === undefined) return UNKNOWN;
  return outcome === 'passed' ? 'clean' : outcome === 'not-run' ? 'pending' : outcome;
}

const LABELS = {
  pending: 'Ready',
  running: 'Running',
  clean: 'Passed',
  failed: 'Failed',
  undecided: 'Review',
  errored: 'Error',
  // Not a state a run can be in — a state this *page* can be in, about a run it
  // was handed without one. Saying so beats picking the reassuring answer.
  unknown: 'No verdict',
};

function statusLabel(status) {
  return LABELS[status] ?? status;
}

/**
 * Whether the verdict is one the reader should stop at.
 *
 * `undecided` counts. That is the whole point of it having its own word: a run
 * that could not establish what it claims to check is not a run that passed.
 */
function needsAttention(verdict) {
  return verdict === 'failed' || verdict === 'errored' || verdict === 'undecided' || verdict === UNKNOWN;
}

if (typeof module !== 'undefined') {
  module.exports = { runVerdict, stepVerdict, statusLabel, needsAttention, UNKNOWN };
}

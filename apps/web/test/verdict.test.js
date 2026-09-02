/**
 * That the page and the exit code cannot disagree.
 *
 * They did. The page derived its own verdict from assertion statuses and never
 * looked at capture warnings, so a run with every assertion passing and a
 * `scope-truncated` warning showed a green dot while `tuplescope run` called it
 * undecided and exited 3 — a second implementation of the one judgement this
 * product is for, silently drifted from the first.
 *
 * These tests pin the fix in the only way that lasts: the page reads a verdict
 * and does not compute one, and when it is handed a run without one it says so.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runVerdict, stepVerdict, statusLabel, needsAttention } = require('../public/verdict.js');

describe('the run verdict', () => {
  it('is whatever the runtime computed', () => {
    for (const outcome of ['clean', 'failed', 'errored', 'undecided']) {
      assert.equal(runVerdict({ verdict: { outcome } }), outcome);
    }
  });

  it('does not re-derive it from what the page can see', () => {
    // The regression. Every assertion passed; the capture said the scope was
    // truncated; `verdictOf` said undecided. A rule that reads the assertions
    // would answer `clean` here, which is the bug.
    const run = {
      verdict: { outcome: 'undecided', reason: 'the observation was incomplete' },
      steps: [{ outcome: 'passed', assertions: [{ status: 'passed' }] }],
    };
    assert.equal(runVerdict(run), 'undecided');
  });

  it('says it has no verdict rather than assuming a good one', () => {
    // An older stored run carries no verdict. Guessing from the assertions is
    // exactly the code this replaced, so the honest answer is that the payload
    // did not say.
    assert.equal(runVerdict({ steps: [{ assertions: [{ status: 'passed' }] }] }), 'unknown');
    assert.equal(runVerdict({}), 'unknown');
    assert.equal(runVerdict(undefined), 'unknown');
  });
});

describe('the step verdict', () => {
  it('translates the core’s word for a good step into the page’s', () => {
    // `outcomeOfStep` says `passed`; the palette and the labels say `clean`.
    // One place where the two vocabularies meet, rather than a `=== 'passed'`
    // at every use.
    assert.equal(stepVerdict({ outcome: 'passed' }), 'clean');
  });

  it('passes the other outcomes through unchanged', () => {
    assert.equal(stepVerdict({ outcome: 'failed' }), 'failed');
    assert.equal(stepVerdict({ outcome: 'errored' }), 'errored');
    assert.equal(stepVerdict({ outcome: 'undecided' }), 'undecided');
  });

  it('shows a step that never ran as ready, not as passed', () => {
    // `not-run` reaching the palette as anything green would put a tick beside
    // a step nobody executed.
    assert.equal(stepVerdict({ outcome: 'not-run' }), 'pending');
  });

  it('says nothing rather than guessing for a step with no outcome', () => {
    assert.equal(stepVerdict({ assertions: [{ status: 'passed' }] }), 'unknown');
  });
});

describe('what the reader is told', () => {
  it('never labels an undecided run as passed', () => {
    // The label is the sentence a person reads. `Review` is the whole reason
    // `undecided` has a word of its own.
    assert.equal(statusLabel('undecided'), 'Review');
    assert.notEqual(statusLabel('undecided'), statusLabel('clean'));
  });

  it('has a visible label for a run it cannot judge', () => {
    assert.equal(statusLabel('unknown'), 'No verdict');
  });

  it('counts undecided and unknown as needing attention', () => {
    // A run that could not establish what it claims to check is not a run that
    // passed, and a run with no verdict is not one either.
    assert.deepEqual(
      ['clean', 'failed', 'errored', 'undecided', 'unknown'].map(needsAttention),
      [false, true, true, true, true],
    );
  });
});

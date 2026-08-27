/**
 * What an agent is told, and what it is shown.
 *
 * These are not style checks. This session's own experience with another MCP
 * server is the evidence: an agent that has only tool descriptions will read a
 * status field, take the obvious meaning, and be wrong — and the failure is
 * silent, because the result looked like an answer. The instructions and the
 * result prose are the only places that can prevent it, so they are tested like
 * code.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INSTRUCTIONS } from './instructions.js';

/**
 * The text is hard-wrapped, so a phrase can straddle a newline. Matching on the
 * raw string makes these tests fail for a reason that has nothing to do with
 * what the instructions say.
 */
const FLAT = INSTRUCTIONS.replace(/\s+/g, ' ');

describe('the handshake instructions', () => {
  it('name the trap before anything else', () => {
    // An agent reads until it finds something actionable. The distinction
    // between engineStatus and verdict has to arrive early enough to be read.
    const head = INSTRUCTIONS.slice(0, 1200);
    assert.match(head, /engineStatus/);
    assert.match(head, /verdict/);
    assert.match(FLAT, /the verdict is the one that is right/);
  });

  it('say outright that undecided is not a pass', () => {
    assert.match(FLAT, /\*\*undecided is not a pass\.\*\*/);
    // ...and not a failure either, or an agent swings the other way and tells
    // the user their code is broken when the scenario is what needs fixing.
    assert.match(FLAT, /not a failure either/);
    assert.match(FLAT, /do not tell the user their code is broken/i);
  });

  it('give the four outcomes and their exit codes', () => {
    for (const [outcome, code] of [
      ['clean', '0'],
      ['failed', '1'],
      ['errored', '2'],
      ['undecided', '3'],
    ]) {
      assert.match(
        INSTRUCTIONS,
        new RegExp(`${outcome}\\s+${code}\\b`),
        `${outcome} should be listed with exit ${code}`,
      );
    }
  });

  it('explain that a clean run can still be qualified', () => {
    assert.match(INSTRUCTIONS, /proves.*bounded/s);
    assert.match(FLAT, /carry the qualification/);
  });

  it('point at check_scenarios before running, and say why', () => {
    assert.match(INSTRUCTIONS, /check_scenarios/);
    assert.match(FLAT, /misspelled table/);
  });

  it('teach hasWrite over isEmpty for idempotency, with the reason', () => {
    // The whole differentiator. An agent reaching for isEmpty() would write an
    // idempotency check that a write to an ignored column passes straight
    // through.
    assert.match(INSTRUCTIONS, /hasWrite/);
    assert.match(FLAT, /not .isEmpty\(\)., for idempotency/);
    assert.match(INSTRUCTIONS, /updated_at/);
  });

  it('say a negative assertion needs a status assertion beside it', () => {
    assert.match(FLAT, /proves nothing unless the request reached the handler/);
  });

  it('steer towards candidates rather than hand-written assertions', () => {
    assert.match(INSTRUCTIONS, /list_assertion_candidates/);
    assert.match(FLAT, /generated ids/);
  });

  it('state what the server will not do', () => {
    assert.match(FLAT, /No shell, no process control, no arbitrary SQL/);
  });

  it('are long enough to carry all of that and short enough to be read', () => {
    // Under ~2k it cannot have said the above; much over ~8k and it competes
    // with the task for attention.
    assert.ok(INSTRUCTIONS.length > 2000, `too short: ${INSTRUCTIONS.length}`);
    assert.ok(INSTRUCTIONS.length < 8000, `too long: ${INSTRUCTIONS.length}`);
  });

  it('never call a run "successful" without qualification', () => {
    // The word the instructions must not model for the agent.
    const claims = [...FLAT.matchAll(/\bsuccess(ful)?\b/g)];
    for (const claim of claims) {
      const around = FLAT.slice(Math.max(0, claim.index - 90), claim.index + 60);
      assert.match(
        around,
        /not|never|worst|wrong|Do not/i,
        `"success" used approvingly near: ${around.replace(/\n/g, ' ')}`,
      );
    }
  });
});

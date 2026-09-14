/**
 * The policy block names the idle window this invocation watched.
 *
 * Measured before: `run --baseline 0`, `off` and `1000` all reported
 * `policy.baselineWindowMs: 400` — the workspace file's value — while the run
 * itself recorded `{probed:false, windowMs:0}` and `{probed:true,
 * windowMs:1000}`. Both now come from `baselineWindowFor`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { baselineOverride, baselineWindowFor } from './baseline.js';

describe('baselineWindowFor', () => {
  it('reports the flag over the workspace value', () => {
    assert.equal(baselineWindowFor('0', 400), 0);
    assert.equal(baselineWindowFor('off', 400), 0);
    assert.equal(baselineWindowFor('1000', 400), 1000);
  });

  it('falls back to the workspace value, then to 0, as the session does', () => {
    assert.equal(baselineWindowFor(undefined, 400), 400);
    assert.equal(baselineWindowFor(undefined, undefined), 0);
  });

  it('gives the session no override when the flag is absent', () => {
    assert.equal(baselineOverride(undefined), undefined);
    assert.equal(baselineOverride('off'), 0);
  });
});

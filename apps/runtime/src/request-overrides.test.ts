import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Scenario } from '@tuplescope/core';
import { withRequestOverrides } from './request-overrides.js';

const scenario: Scenario = {
  version: 1,
  id: 'payment',
  title: 'Payment',
  datasets: [{
    id: 'happy',
    label: 'Happy',
    steps: [{ id: 'create', name: 'Create', request: { method: 'POST', path: '/payments', as: 'alice', body: { amount: 10 } } }],
  }],
};

describe('browser request overrides', () => {
  it('changes one execution without mutating the scenario default', () => {
    const edited = withRequestOverrides(scenario, 'happy', {
      create: { method: 'PATCH', path: '/payments/one', as: null, idempotencyKey: 'try-2', body: { amount: 999 } },
    }, ['alice']);
    assert.deepEqual(edited.datasets[0]?.steps[0]?.request, {
      method: 'PATCH', path: '/payments/one', idempotencyKey: 'try-2', body: { amount: 999 },
    });
    assert.deepEqual(scenario.datasets[0]?.steps[0]?.request.body, { amount: 10 });
  });

  it('refuses a path that escapes the configured backend', () => {
    assert.throws(() => withRequestOverrides(scenario, 'happy', {
      create: { method: 'POST', path: 'https://elsewhere.test/', as: 'alice', idempotencyKey: null, body: null },
    }, ['alice']), /one slash/);
  });

  it('refuses unknown steps and identities', () => {
    assert.throws(() => withRequestOverrides(scenario, 'happy', {
      missing: { method: 'POST', path: '/payments', as: null, idempotencyKey: null, body: null },
    }, ['alice']), /unknown step/);
    assert.throws(() => withRequestOverrides(scenario, 'happy', {
      create: { method: 'POST', path: '/payments', as: 'mallory', idempotencyKey: null, body: null },
    }, ['alice']), /unknown identity/);
  });
});

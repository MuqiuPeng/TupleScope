/**
 * Engine tests run against fakes for the adapter and the runner, so what is
 * under test is sequencing, variable threading and scoring — not Postgres.
 * The adapter has its own integration tests against a real database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CaptureScope,
  ChangeSet,
  DatabaseAdapter,
  Detection,
  RowChange,
  Scenario,
} from '@statescope/core';
import type { Exchange, HttpRunner } from '@statescope/http-runner';
import { ScenarioEngine, template } from './index.js';

// ─── fakes ────────────────────────────────────────────────────────────────────

const SCOPE: CaptureScope = {
  allTables: true,
  tables: [
    { table: 'payments', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
    { table: 'refunds', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
  ],
};

function emptyChanges(detection: Detection = 'write', changes: RowChange[] = []): ChangeSet {
  return {
    captureMethod: 'mvcc-xmin',
    detection,
    scope: SCOPE,
    changes,
    warnings: [],
    durationMs: 1,
  };
}

interface FakeCall {
  path: string;
  idempotencyKey?: string;
  body?: unknown;
  as?: string;
}

function fakes(options: {
  responses: Array<{ status: number; body: unknown }>;
  changes?: ChangeSet[];
}) {
  const calls: FakeCall[] = [];
  let index = 0;

  const runner = {
    async send(request: {
      method: string;
      path: string;
      idempotencyKey?: string;
      body?: unknown;
      as?: string;
    }): Promise<Exchange> {
      calls.push({
        path: request.path,
        ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
        body: request.body,
        ...(request.as !== undefined ? { as: request.as } : {}),
      });
      const canned = options.responses[Math.min(index, options.responses.length - 1)]!;
      return {
        request: { method: request.method, url: request.path, headers: {} },
        response: {
          status: canned.status,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(canned.body),
          durationMs: 1,
        },
        body: canned.body,
      };
    },
  } as unknown as HttpRunner;

  let resets = 0;
  let probes = 0;

  const adapter: DatabaseAdapter = {
    captureMethod: 'mvcc-xmin',
    detection: 'write',
    async capture(_scope, body) {
      const result = await body();
      const changes = options.changes?.[index] ?? emptyChanges();
      index++;
      return { result, changes };
    },
    async probeBaselineNoise() {
      probes++;
      return emptyChanges();
    },
    async listTables() {
      return ['payments', 'refunds'];
    },
    async close() {},
  };

  return {
    adapter,
    runner,
    calls,
    counts: { get resets() { return resets; }, get probes() { return probes; } },
    reset: async () => {
      resets++;
    },
  };
}

function scenario(steps: Scenario['datasets'][number]['steps'], resetFirst = false): Scenario {
  return {
    version: 1,
    id: 's',
    title: 'S',
    datasets: [{ id: 'd', label: 'D', ...(resetFirst ? { resetFirst } : {}), steps }],
  };
}

const FIXED_NOW = () => new Date('2026-08-26T00:00:00.000Z');

// ─── templating ───────────────────────────────────────────────────────────────

describe('template', () => {
  it('substitutes known names and leaves unknown ones alone', () => {
    assert.equal(template('/p/{{id}}/refund', { id: 'pay_1' }), '/p/pay_1/refund');
    // Leaving it verbatim is deliberate: a blank path segment would produce a
    // confusing 404 instead of an obvious "this was never captured".
    assert.equal(template('/p/{{missing}}', {}), '/p/{{missing}}');
  });

  it('tolerates whitespace inside the braces', () => {
    assert.equal(template('{{ id }}', { id: 'x' }), 'x');
  });

  it('quotes when asked, so a value lands in an expression as a literal', () => {
    assert.equal(template('id == {{v}}', { v: 'a b' }, { quote: true }), 'id == "a b"');
  });
});

// ─── sequencing and variables ─────────────────────────────────────────────────

describe('ScenarioEngine', () => {
  it('threads a captured value into a later step', async () => {
    const f = fakes({ responses: [{ status: 201, body: { id: 'pay_1' } }, { status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });

    await engine.run(
      scenario([
        {
          id: 'create',
          name: 'create',
          request: { method: 'POST', path: '/payments' },
          capture: { payment_id: 'response.body.id' },
        },
        { id: 'refund', name: 'refund', request: { method: 'POST', path: '/payments/{{payment_id}}/refund' } },
      ]),
      'd',
      SCOPE,
    );

    assert.equal(f.calls[1]!.path, '/payments/pay_1/refund');
  });

  it('gives every run a distinct {{run}} so idempotency keys do not collide', async () => {
    const build = () =>
      scenario([
        {
          id: 'a',
          name: 'a',
          request: { method: 'POST', path: '/p', idempotencyKey: 'k-{{run}}' },
        },
      ]);

    const f = fakes({ responses: [{ status: 201, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: () => new Date(1000) });
    await engine.run(build(), 'd', SCOPE);

    const g = fakes({ responses: [{ status: 201, body: {} }] });
    const engine2 = new ScenarioEngine({ adapter: g.adapter, runner: g.runner, now: () => new Date(99_000_000) });
    await engine2.run(build(), 'd', SCOPE);

    assert.notEqual(f.calls[0]!.idempotencyKey, g.calls[0]!.idempotencyKey);
    assert.doesNotMatch(f.calls[0]!.idempotencyKey!, /\{\{/);
  });

  it('carries {{run}} into a partial run, so a replay really replays', async () => {
    // Pairing a previous run's captured ids with a fresh suffix is not a replay
    // of anything — the idempotency key would not match, and a step meant to
    // send a duplicate would send a brand new request instead.
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: () => new Date(5000) });
    await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' } },
        { id: 'b', name: 'b', request: { method: 'POST', path: '/b', idempotencyKey: 'k-{{run}}' } },
      ]),
      'd',
      SCOPE,
      { onlyStepId: 'b', variables: { run: 'CARRIED', payment_id: 'pay_1' } },
    );
    assert.equal(f.calls[0]!.idempotencyKey, 'k-CARRIED');
  });

  it('still mints a fresh {{run}} for a full run', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: () => new Date(5000) });
    await engine.run(
      scenario([{ id: 'a', name: 'a', request: { method: 'POST', path: '/a', idempotencyKey: 'k-{{run}}' } }]),
      'd',
      SCOPE,
      { variables: { run: 'STALE' } },
    );
    assert.notEqual(f.calls[0]!.idempotencyKey, 'k-STALE');
  });

  it('templates into the request body, not just the path', async () => {
    const f = fakes({ responses: [{ status: 201, body: { id: 'x' } }, { status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, capture: { id: 'response.body.id' } },
        {
          id: 'b',
          name: 'b',
          request: { method: 'POST', path: '/b', body: { ref: '{{id}}', nested: { also: '{{id}}' } } },
        },
      ]),
      'd',
      SCOPE,
    );
    assert.deepEqual(f.calls[1]!.body, { ref: 'x', nested: { also: 'x' } });
  });

  it('stops at the first failing step, because later steps depend on it', async () => {
    const f = fakes({ responses: [{ status: 500, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, assert: ['response.status == 201'] },
        { id: 'b', name: 'b', request: { method: 'POST', path: '/b' } },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'failed');
    assert.equal(run.steps.length, 1);
    assert.equal(f.calls.length, 1);
  });

  it('scores an expected rejection as a pass and keeps going', async () => {
    const f = fakes({ responses: [{ status: 422, body: { error: 'ALREADY_REFUNDED' } }, { status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, expectStatus: 422 },
        { id: 'b', name: 'b', request: { method: 'POST', path: '/b' } },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'passed');
    assert.equal(run.steps.length, 2);
  });

  it('fails when a step expected to be refused succeeds instead', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([{ id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, expectStatus: 422 }]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'failed');
    assert.equal(run.steps[0]!.assertions[0]!.expected, '422');
    assert.equal(run.steps[0]!.assertions[0]!.actual, '200');
  });

  it('marks an undecidable assertion unevaluable, not failed', async () => {
    const f = fakes({
      responses: [{ status: 200, body: {} }],
      changes: [emptyChanges('value')],
    });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        {
          id: 'a',
          name: 'a',
          request: { method: 'POST', path: '/a' },
          assert: ['hasWrite(changes(*)) == false'],
        },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.steps[0]!.assertions[0]!.status, 'unevaluable');
    // Unevaluable is not a failure: the run did not prove the opposite either.
    assert.equal(run.status, 'passed');
    assert.match(run.steps[0]!.assertions[0]!.reason!, /write detection/);
  });

  it('resets before a dataset that asks for it, and only then', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const withReset = new ScenarioEngine({
      adapter: f.adapter,
      runner: f.runner,
      reset: f.reset,
      now: FIXED_NOW,
    });
    await withReset.run(scenario([{ id: 'a', name: 'a', request: { method: 'GET', path: '/a' } }]), 'd', SCOPE);
    assert.equal(f.counts.resets, 0);

    await withReset.run(
      scenario([{ id: 'a', name: 'a', request: { method: 'GET', path: '/a' } }], true),
      'd',
      SCOPE,
    );
    assert.equal(f.counts.resets, 1);
  });

  it('says so rather than silently skipping when reset is unavailable', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    await assert.rejects(
      engine.run(scenario([{ id: 'a', name: 'a', request: { method: 'GET', path: '/a' } }], true), 'd', SCOPE),
      /no reset command/,
    );
  });

  it('records baseline noise only when the idle window found something', async () => {
    const quiet = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({
      adapter: quiet.adapter,
      runner: quiet.runner,
      baselineWindowMs: 10,
      now: FIXED_NOW,
    });
    const run = await engine.run(
      scenario([{ id: 'a', name: 'a', request: { method: 'GET', path: '/a' } }]),
      'd',
      SCOPE,
    );
    assert.equal(quiet.counts.probes, 1);
    assert.equal(run.baselineNoise, undefined);
  });

  it('names an unknown dataset instead of running the first one', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    await assert.rejects(
      engine.run(scenario([{ id: 'a', name: 'a', request: { method: 'GET', path: '/a' } }]), 'nope', SCOPE),
      /has no dataset `nope`/,
    );
  });

  it('turns a transport failure into a typed error with a remedy', async () => {
    const broken: HttpRunner = {
      async send() {
        const { HttpRunnerError } = await import('@statescope/http-runner');
        throw new HttpRunnerError('POST http://127.0.0.1:9/a failed: ECONNREFUSED', 'http://127.0.0.1:9/a');
      },
    } as unknown as HttpRunner;
    const f = fakes({ responses: [] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: broken, now: FIXED_NOW });
    const run = await engine.run(
      scenario([{ id: 'a', name: 'a', request: { method: 'POST', path: '/a' } }]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'errored');
    assert.equal(run.steps[0]!.error!.kind, 'request');
    assert.match(run.steps[0]!.error!.remedy!, /backend is running/);
  });
});

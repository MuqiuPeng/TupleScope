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
} from '@tuplescope/core';
import { visible } from '@tuplescope/core';
import { Unevaluable } from '@tuplescope/expr';
import type { Exchange, HttpRunner } from '@tuplescope/http-runner';
import { ScenarioEngine, template } from './index.js';

// ─── fakes ────────────────────────────────────────────────────────────────────

const SCOPE: CaptureScope = {
  schema: 'public',
  database: 'test',
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
    fidelity: 'net',
    scope: SCOPE,
    changes,
    // Required, so a ChangeSet cannot exist without saying how its text was printed.
    rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
    warnings: [],
    durationMs: 1,
  };
}

interface FakeCall {
  path: string;
  idempotencyKey?: string;
  body?: unknown;
  as?: string;
  headers?: Readonly<Record<string, string>>;
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
      headers?: Readonly<Record<string, string>>;
    }): Promise<Exchange> {
      calls.push({
        path: request.path,
        ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
        body: request.body,
        ...(request.as !== undefined ? { as: request.as } : {}),
        ...(request.headers !== undefined ? { headers: request.headers } : {}),
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
    fidelity: 'net',
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

  it('fails a step that got an error status it never said to expect', async () => {
    // The forbidden green this closes: a negative assertion — "nothing was
    // written" — is evidence only if the request reached the handler. Over a
    // 401 nothing was written because nothing ran, and the assertion passes
    // vacuously. Rotate a token or mistype a path and the double-charge check
    // goes green exactly when it stops working.
    for (const status of [401, 404, 500, 503]) {
      const f = fakes({ responses: [{ status, body: {} }] });
      const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
      const run = await engine.run(
        scenario([
          {
            id: 'replay',
            name: 'replay',
            request: { method: 'POST', path: '/a' },
            assert: ['hasWrite(changes(*)) == false'],
          },
        ]),
        'd',
        SCOPE,
      );
      assert.equal(run.status, 'failed', `HTTP ${status} should not pass`);
      const injected = run.steps[0]!.assertions[0]!;
      assert.equal(injected.source, 'response.status < 400');
      assert.equal(injected.actual, String(status));
      // The message has to explain why an unasked-for check appeared.
      assert.match(injected.reason!, /Assertions about what was NOT written prove nothing/);
    }
  });

  it('still lets a 2xx through with no expectStatus', async () => {
    for (const status of [200, 201, 204]) {
      const f = fakes({ responses: [{ status, body: {} }] });
      const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
      const run = await engine.run(
        scenario([{ id: 'a', name: 'a', request: { method: 'POST', path: '/a' } }]),
        'd',
        SCOPE,
      );
      assert.equal(run.status, 'passed', `HTTP ${status} should pass`);
      assert.equal(run.steps[0]!.assertions.length, 0);
    }
  });

  it('refuses an assertion whose placeholder nothing captured', async () => {
    // Predicates are raw source slices, not parsed nodes, so the evaluator's
    // own "no variable was captured" guard never sees them: the text
    // `{{payment_id}}` gets compared against the column, matches nothing, and
    // `count(...) == 0` passes over the very row it was written to catch.
    const f = fakes({ responses: [{ status: 200, body: { paymentId: 'p1' } }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        {
          id: 'create',
          name: 'create',
          request: { method: 'POST', path: '/a' },
          capture: { payment_id: 'response.body.id' }, // the field is `paymentId`
        },
        {
          id: 'check',
          name: 'check',
          request: { method: 'POST', path: '/b' },
          assert: ['count(inserted(refunds).where(payment_id = {{payment_id}})) == 0'],
        },
      ]),
      'd',
      SCOPE,
    );
    const result = run.steps[1]!.assertions[0]!;
    assert.equal(result.status, 'unevaluable');
    assert.match(result.reason!, /nothing captured `payment_id`/);
  });

  it('does not quote a placeholder that is already quoted', async () => {
    // `where(id = '{{payment_id}}')` is how the examples quote every other
    // literal. Quoting again produced `"p1"` with the quotes inside the value,
    // which matches no row — so the assertion passed while the row it was
    // looking for sat in the diff.
    assert.equal(
      template("where(id = '{{payment_id}}')", { payment_id: 'p1' }, { quote: true }),
      "where(id = 'p1')",
    );
    assert.equal(
      template('where(id = "{{payment_id}}")', { payment_id: 'p1' }, { quote: true }),
      'where(id = "p1")',
    );
    // Unquoted still gets quoted, so a value with a space cannot split a token.
    assert.equal(
      template('where(id = {{payment_id}})', { payment_id: 'a b' }, { quote: true }),
      'where(id = "a b")',
    );
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
        const { HttpRunnerError } = await import('@tuplescope/http-runner');
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

describe('a placeholder inside a string literal', () => {
  it('is spliced as text, not quoted into the middle of the literal', () => {
    // It was JSON-quoted unless both neighbours were quotes, so this became
    // `"PVT-"pay_1""` and failed to parse.
    assert.equal(
      template('single(inserted(t)).after.ref == "PVT-{{x}}"', { x: 'pay_1' }, { quote: true }),
      'single(inserted(t)).after.ref == "PVT-pay_1"',
    );
    assert.equal(
      template("x == 'a-{{x}}-{{y}}'", { x: 'p', y: 'q' }, { quote: true }),
      "x == 'a-p-q'",
    );
  });

  it('escapes the literal\'s own quote and backslashes, by the lexer\'s rule', () => {
    assert.equal(template('x == "PVT-{{v}}"', { v: 'a"b\\c' }, { quote: true }), 'x == "PVT-a\\"b\\\\c"');
    // The other quote character is not special inside this literal.
    assert.equal(template("x == 'PVT-{{v}}'", { v: 'a"b' }, { quote: true }), "x == 'PVT-a\"b'");
    assert.equal(template("x == '{{v}}'", { v: "it's" }, { quote: true }), "x == 'it\\'s'");
    // Standing alone, the same rule inside the quotes it is given. JSON's `\n`
    // would have reached the lexer as the letter n.
    assert.equal(template('x == {{v}}', { v: 'a"b\nc' }, { quote: true }), 'x == "a\\"b\nc"');
  });

  it('reads predicates as before when the value needs no escaping', () => {
    assert.equal(
      template('count(rows(t, id = "{{v}}")) == 1', { v: "it's" }, { quote: true }),
      'count(rows(t, id = "it\'s")) == 1',
    );
  });

  it('refuses a value a predicate could only read wrongly', () => {
    // A predicate's quoted value has no escapes (parsePredicate reads it raw),
    // so an escaped value would be matched as the escaped characters.
    for (const [source, v] of [
      ['count(rows(t, id = "{{v}}")) == 0', 'p1", status = "x'],
      ["count(inserted(t).where(id = '{{v}}')) == 0", "it's"],
      ['count(inserted(t).where(id = {{v}})) == 0', 'a\\b'],
      ['count(inserted(t).where(id = "{{v}}")) == 0', 'a\\b'],
    ] as const) {
      assert.throws(
        () => template(source, { v }, { quote: true }),
        (error: unknown) => error instanceof Unevaluable && /predicate's quoted value, which has no escapes/.test(error.message),
        source,
      );
    }
  });

  const exchangeStep = (assertion: string) =>
    scenario([
      { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, capture: { v: 'response.body.v' } },
      { id: 'b', name: 'b', request: { method: 'GET', path: '/b' }, assert: [assertion] },
    ]);

  it('cannot break out of a literal the author quoted', async () => {
    // Spliced raw because both neighbours were quotes, this value made the
    // assertion `response.body.label == "nope" or "a" == "a"` — always true.
    const f = fakes({
      responses: [
        { status: 201, body: { v: 'nope" or "a" == "a' } },
        { status: 200, body: { label: 'something else' } },
      ],
    });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(exchangeStep('response.body.label == "{{v}}"'), 'd', SCOPE);
    assert.equal(run.steps[1]!.assertions[0]!.status, 'failed');
  });

  it('compares a value with a quote and a backslash inside a longer literal', async () => {
    const f = fakes({
      responses: [
        { status: 201, body: { v: 'a"b\\c' } },
        { status: 200, body: { label: 'PVT-a"b\\c' } },
      ],
    });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(exchangeStep('response.body.label == "PVT-{{v}}"'), 'd', SCOPE);
    assert.equal(run.steps[1]!.assertions[0]!.status, 'passed', run.steps[1]!.assertions[0]!.reason);
  });

  it('refuses, rather than answers, a predicate a captured value would rewrite', async () => {
    // Raw, this was `where(id = "p1", status = "x")` — two clauses, one of
    // them the API's. JSON-quoted, `a\b` was matched as `a\\b`. Either way the
    // guard found nothing and passed over the row that was there.
    const row: RowChange = {
      table: 'payments',
      key: null,
      kind: 'insert',
      before: null,
      after: { id: visible('text', 'a\\b') },
      changedColumns: ['id'],
      visibleColumns: ['id'],
      hasWrite: true,
    };
    for (const [assertion, v] of [
      ['count(inserted(payments).where(id = "{{v}}")) == 0', 'p1", status = "x'],
      ['count(inserted(payments).where(id = {{v}})) == 0', 'a\\b'],
    ] as const) {
      const f = fakes({
        responses: [{ status: 201, body: { v } }, { status: 200, body: {} }],
        changes: [emptyChanges(), emptyChanges('write', [row])],
      });
      const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
      const run = await engine.run(exchangeStep(assertion), 'd', SCOPE);
      const result = run.steps[1]!.assertions[0]!;
      assert.equal(result.status, 'unevaluable', `${assertion}: ${result.status}`);
      assert.match(result.reason!, /captured `v`/);
    }
  });

  it('does not mistake a captured value that looks like a placeholder for a missing one', async () => {
    const f = fakes({
      responses: [
        { status: 201, body: { v: '{{zzz}}' } },
        { status: 200, body: { label: '{{zzz}}' } },
      ],
    });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(exchangeStep('response.body.label == "{{v}}"'), 'd', SCOPE);
    assert.equal(run.steps[1]!.assertions[0]!.status, 'passed', run.steps[1]!.assertions[0]!.reason);
  });
});

describe('a variable nothing has captured yet', () => {
  const steps = scenario([
    { id: 'create', name: 'create', request: { method: 'POST', path: '/i' }, capture: { intent_id: 'response.body.id' } },
    { id: 'read', name: 'read', request: { method: 'GET', path: '/i/{{intent_id}}' } },
    { id: 'typo', name: 'typo', request: { method: 'GET', path: '/i/{{intnet_id}}' } },
    { id: 'early', name: 'early', request: { method: 'GET', path: '/l/{{late_id}}' } },
    { id: 'late', name: 'late', request: { method: 'POST', path: '/l' }, capture: { late_id: 'response.body.id' } },
  ]);
  const errorFor = async (only: string) => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(steps, 'd', SCOPE, { onlyStepId: only, variables: {} });
    assert.equal(run.status, 'errored');
    return run.steps[0]!.error!;
  };

  it('names the step whose capture defines it', async () => {
    // "start from the step that does" left the reader to find it.
    const error = await errorFor('read');
    assert.match(error.message, /Step `read` needs `intent_id`/);
    assert.match(error.remedy!, /start from the step that does: `intent_id` is captured by `create`\./);
  });

  it('says so when no earlier step captures it at all', async () => {
    assert.match((await errorFor('typo')).remedy!, /No step before `typo` captures `intnet_id`/);
    assert.match(
      (await errorFor('early')).remedy!,
      /`late_id` is captured only by `late`, which runs after `early`/,
    );
  });
});

describe('a secret reference written into a scenario', () => {
  it('is refused rather than sent as those characters', async () => {
    // Scenario files are not resolved — `${secret:…}` is a workspace thing,
    // because `identities` is where authentication is declared once. Left
    // alone it would go out verbatim and come back as a puzzling 401.
    const f = fakes({ responses: [{ status: 201, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        {
          id: 'create',
          name: 'create',
          request: {
            method: 'POST',
            path: '/payments',
            headers: { authorization: 'Bearer ${secret:alice_token}' },
          },
        },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'errored');
    const message = run.steps[0]?.error?.message ?? '';
    assert.match(message, /do not resolve secret references/);
    assert.match(message, /Put the credential in `identities`/);
    // ...and the reference is named, so the fix is obvious rather than a hunt.
    assert.match(message, /alice_token/);
    assert.equal(f.calls.length, 0, 'nothing should have been sent');
  });

  it('lets an ordinary header through untouched', async () => {
    const f = fakes({ responses: [{ status: 201, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        {
          id: 'create',
          name: 'create',
          request: { method: 'POST', path: '/payments', headers: { 'x-trace': 'abc' } },
        },
      ]),
      'd',
      SCOPE,
    );
    assert.notEqual(run.status, 'errored');
  });
});

describe('a placeholder in a header', () => {
  // Path, idempotency key and body were templated; a header was not, so a
  // `{{name}}` there went out as those characters, captured or not, and the
  // step passed (ts-fix2/engine-ws/probe.mjs).
  it('is templated like the path and the body', async () => {
    const f = fakes({ responses: [{ status: 200, body: { id: 'p1' } }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, capture: { id: 'response.body.id' } },
        { id: 'b', name: 'b', request: { method: 'GET', path: '/b', headers: { 'x-intent': 'i-{{id}}' } } },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'passed', JSON.stringify(run.steps.map((s) => s.error)));
    assert.deepEqual(f.calls[1]!.headers, { 'x-intent': 'i-p1' });
  });

  it('is refused, naming the variable, when nothing captured it', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([{ id: 'b', name: 'b', request: { method: 'GET', path: '/b', headers: { 'x-intent': '{{never}}' } } }]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'errored');
    assert.match(run.steps[0]!.error!.message, /Step `b` needs `never`, which nothing has captured yet/);
    assert.equal(f.calls.length, 0, 'nothing should have been sent');
  });
});

describe('a `${…}` written into a request', () => {
  // A scenario file resolves no `${…}` of any kind. Only the exact
  // `${secret:name}` spelling used to be refused; every form below went out
  // as those characters and the step passed (ts-fix/engine-ws/verbatim.mjs).
  type Request = Scenario['datasets'][number]['steps'][number]['request'];
  const runWith = async (request: Request) => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(scenario([{ id: 'send', name: 'send', request }]), 'd', SCOPE);
    return { run, calls: f.calls };
  };

  const cases: Array<[string, Request, string]> = [
    [
      'an environment reference in a header',
      { method: 'GET', path: '/h', headers: { authorization: 'Bearer ${DOSSH_TOKEN_ACCT_DEMO}' } },
      '`request.headers.authorization` holds `${DOSSH_TOKEN_ACCT_DEMO}`',
    ],
    [
      'one with a default, in the body',
      { method: 'POST', path: '/h', body: { merchant: '${MERCHANT_ID:-m1}' } },
      '`request.body.merchant` holds `${MERCHANT_ID:-m1}`',
    ],
    [
      'a secret written with a space',
      { method: 'GET', path: '/h', headers: { authorization: 'Bearer ${secret: alice_token}' } },
      '`request.headers.authorization` holds `${secret: alice_token}`',
    ],
    [
      'a secret written in upper case',
      { method: 'GET', path: '/h/${SECRET:alice_token}' },
      '`request.path` holds `${SECRET:alice_token}`',
    ],
    [
      'one in the idempotency key',
      { method: 'POST', path: '/h', idempotencyKey: 'k-${RUN}' },
      '`request.idempotencyKey` holds `${RUN}`',
    ],
    [
      'one in a key, deep in the body',
      { method: 'POST', path: '/h', body: { items: [{ '${FIELD}': 1 }] } },
      '`request.body.items.0` holds `${FIELD}` in a key',
    ],
  ];
  for (const [label, request, named] of cases) {
    it(`refuses ${label}, names the field, and sends nothing`, async () => {
      const { run, calls } = await runWith(request);
      assert.equal(run.status, 'errored');
      const error = run.steps[0]!.error!;
      assert.equal(error.kind, 'configuration');
      assert.ok(error.message.includes(named), error.message);
      assert.equal(calls.length, 0, 'nothing should have been sent');
    });
  }

  it('says what to write instead, in one sentence', async () => {
    const { run } = await runWith({
      method: 'POST',
      path: '/p/${TENANT}',
      headers: { authorization: 'Bearer ${TOKEN}' },
    });
    assert.equal(
      run.steps[0]!.error!.message,
      'Step `send`: `request.path` holds `${TENANT}` and `request.headers.authorization` holds ' +
        '`${TOKEN}`, and a scenario file resolves no `${…}` reference, so they would reach the API as ' +
        'those characters — use `identities` in the workspace file with `as:` for a credential, ' +
        '`capture:` and `{{name}}` for a value from an earlier response, or `$${` to send the ' +
        'characters `${` themselves.',
    );
  });

  it('keeps the secret sentence for a well-formed `${secret:name}`, and files it as configuration', async () => {
    // It was filed as `capture`, which the step's status column prints.
    const { run } = await runWith({
      method: 'GET',
      path: '/h',
      headers: { authorization: 'Bearer ${secret:alice_token}' },
    });
    const error = run.steps[0]!.error!;
    assert.equal(error.kind, 'configuration');
    assert.match(
      error.message,
      /^Step `send` refers to `\$\{secret:alice_token\}`, and scenario files do not resolve secret references/,
    );
  });

  it('sends `$${` as `${`, and still puts a captured value beside it', async () => {
    const f = fakes({ responses: [{ status: 200, body: { id: 'p1' } }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, capture: { id: 'response.body.id' } },
        {
          id: 'b',
          name: 'b',
          request: {
            method: 'POST',
            path: '/b/{{id}}/$${literal}',
            headers: { 'x-t': 'a $${b}' },
            idempotencyKey: 'k-{{id}}-$${c}',
            body: { t: 'Hello $${name}', 'k$${d}': ['$${e}', '{{id}}'] },
          },
        },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'passed', JSON.stringify(run.steps.map((s) => s.error)));
    assert.deepEqual(f.calls[1], {
      path: '/b/p1/${literal}',
      headers: { 'x-t': 'a ${b}' },
      idempotencyKey: 'k-p1-${c}',
      body: { t: 'Hello ${name}', 'k${d}': ['${e}', 'p1'] },
    });
  });

  it('sends a captured value as it came, even one that looks like a reference', async () => {
    // A value from the API is data. The old check read the templated request,
    // so a captured `${secret:x}` refused the step, and a `$${` would now be
    // unescaped if the escape were applied after templating.
    const value = '${secret:x} ${Y} $${z}';
    const f = fakes({ responses: [{ status: 200, body: { v: value } }] });
    const engine = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: FIXED_NOW });
    const run = await engine.run(
      scenario([
        { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, capture: { v: 'response.body.v' } },
        { id: 'b', name: 'b', request: { method: 'POST', path: '/b/{{v}}', body: { v: '{{v}}' } } },
      ]),
      'd',
      SCOPE,
    );
    assert.equal(run.status, 'passed', JSON.stringify(run.steps.map((s) => s.error)));
    assert.equal(f.calls[1]!.path, `/b/${value}`);
    assert.deepEqual(f.calls[1]!.body, { v: value });
  });
});

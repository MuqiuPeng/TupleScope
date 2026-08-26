import { describe, it } from 'node:test';
import { verdictOf } from '@statescope/core';
import type { CaptureScope, ChangeSet, DatabaseAdapter, Detection, RowChange, Scenario } from '@statescope/core';
import type { Exchange, HttpRunner } from '@statescope/http-runner';
import { ScenarioEngine } from './index.js';

const SCOPE: CaptureScope = {
  allTables: true,
  tables: [
    { table: 'payments', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
    { table: 'refunds', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' },
  ],
};
function emptyChanges(detection: Detection = 'write', changes: RowChange[] = []): ChangeSet {
  return { captureMethod: 'mvcc-xmin', detection, scope: SCOPE, changes, warnings: [], durationMs: 1 };
}
function fakes(options: { responses: Array<{ status: number; body: unknown }>; changes?: ChangeSet[] }) {
  let index = 0;
  const runner = {
    async send(request: any): Promise<Exchange> {
      const canned = options.responses[Math.min(index, options.responses.length - 1)]!;
      return {
        request: { method: request.method, url: request.path, headers: {} },
        response: { status: canned.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(canned.body), durationMs: 1 },
        body: canned.body,
      };
    },
  } as unknown as HttpRunner;
  const adapter: DatabaseAdapter = {
    captureMethod: 'mvcc-xmin', detection: 'write',
    async capture(_s, body) { const result = await body(); const changes = options.changes?.[index] ?? emptyChanges(); index++; return { result, changes }; },
    async probeBaselineNoise() { return emptyChanges(); },
    async listTables() { return ['payments', 'refunds']; },
    async close() {},
  };
  return { adapter, runner };
}
const scenario = (steps: any): Scenario => ({ version: 1, id: 's', title: 'S', datasets: [{ id: 'd', label: 'D', steps }] });
const NOW = () => new Date('2026-08-26T00:00:00.000Z');
const dump = (label: string, run: any) => {
  const v = verdictOf(run);
  console.log(`\n### ${label}`);
  console.log('  run.status =', run.status, '| coverage', run.coverage, '| steps', run.steps.length);
  console.log('  step statuses =', run.steps.map((s: any) => `${s.stepId}:${s.status}(${s.response?.status ?? 'no-resp'})`).join(', '));
  console.log('  assertions =', JSON.stringify(run.steps.flatMap((s: any) => s.assertions)));
  console.log('  VERDICT outcome =', v.outcome, '| exit', {clean:0,failed:1,errored:2,undecided:3}[v.outcome]);
  console.log('  reason =', v.reason, '| proves', v.proves);
  console.log('  boundedBy =', JSON.stringify(v.boundedBy));
  console.log('  baseline =', JSON.stringify(v.baseline));
};

describe('probe', () => {
  it('A: idempotency replay gets 500, negative assertion passes', async () => {
    const f = fakes({ responses: [{ status: 500, body: { error: 'boom' } }] });
    const e = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: NOW });
    const run = await e.run(scenario([
      { id: 'replay', name: 'replay the same request', request: { method: 'POST', path: '/payments' }, idempotencyKey: 'k', assert: ['hasWrite(changes(*)) == false'] },
    ]), 'd', SCOPE);
    dump('A idempotency replay on a 500', run);
  });

  it('B: early break leaves coverage full', async () => {
    const f = fakes({ responses: [{ status: 500, body: {} }] });
    const e = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: NOW });
    const run = await e.run(scenario([
      { id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, assert: ['response.status == 201'] },
      { id: 'b', name: 'b', request: { method: 'POST', path: '/b' }, assert: ['response.status == 200'] },
      { id: 'c', name: 'c', request: { method: 'POST', path: '/c' }, assert: ['response.status == 200'] },
    ]), 'd', SCOPE);
    dump('B early break (3 steps declared, 1 ran)', run);
  });

  it('C: capture silently misses, later step errors', async () => {
    const f = fakes({ responses: [{ status: 200, body: { paymentId: 'p1' } }, { status: 200, body: {} }] });
    const e = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: NOW });
    const run = await e.run(scenario([
      { id: 'create', name: 'create', request: { method: 'POST', path: '/payments' }, capture: { payment_id: 'response.body.id' } },
      { id: 'refund', name: 'refund', request: { method: 'POST', path: '/payments/{{payment_id}}/refund' } },
    ]), 'd', SCOPE);
    dump('C missing capture -> MissingVariableError', run);
  });

  it('D: unresolved placeholder inside a quoted predicate', async () => {
    const f = fakes({ responses: [{ status: 200, body: { paymentId: 'p1' } }, { status: 200, body: {} }] });
    const e = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: NOW });
    const run = await e.run(scenario([
      { id: 'create', name: 'create', request: { method: 'POST', path: '/payments' }, capture: { payment_id: 'response.body.id' } },
      { id: 'check', name: 'check nothing else touched it', request: { method: 'GET', path: '/health' },
        assert: ["changes(payments).where(id = '{{payment_id}}').isEmpty()"] },
    ]), 'd', SCOPE);
    dump('D vacuous predicate from an uncaptured variable', run);
  });

  it('E: default baseline window', async () => {
    const f = fakes({ responses: [{ status: 200, body: {} }] });
    const e = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: NOW });
    const run = await e.run(scenario([{ id: 'a', name: 'a', request: { method: 'GET', path: '/a' }, assert: ['response.status == 200'] }]), 'd', SCOPE);
    dump('E default baselineWindowMs (unprobed)', run);
  });

  it('F: step with only prose expect and no assert, 500 response', async () => {
    const f = fakes({ responses: [{ status: 503, body: {} }] });
    const e = new ScenarioEngine({ adapter: f.adapter, runner: f.runner, now: NOW });
    const run = await e.run(scenario([{ id: 'a', name: 'a', request: { method: 'POST', path: '/a' }, expect: 'payment is created' }]), 'd', SCOPE);
    dump('F prose-only step on a 503', run);
  });
});

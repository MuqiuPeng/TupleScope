/**
 * The ordering tests. Every case here goes red against the code as it was
 * written the first time, which is the point: the previous test for this rule
 * rebuilt the handler by hand and stayed green while the real one was wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunAdmission, type RunSlot } from './run-admission.js';

interface Job extends RunSlot {
  createdAt: string;
}

const job = (id: string): Job => ({ id, status: 'running', createdAt: '2026-09-13T00:00:00.000Z' });

/** A refusal that only completes when the test says so. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

describe('admitting a run', () => {
  it('admits the first, and mints an id', async () => {
    const jobs = new Map<string, Job>();
    const admit = createRunAdmission<Job>({ jobs, create: job, refuse: async () => undefined });

    const admission = await admit();
    assert.equal(admission.admitted, true);
    assert.ok(admission.admitted && jobs.get(admission.job.id), 'the slot is registered');
  });

  it('refuses a second run with 409 and the id of the one still going', async () => {
    const jobs = new Map<string, Job>();
    const admit = createRunAdmission<Job>({ jobs, create: job, refuse: async () => undefined });

    const first = await admit();
    assert.ok(first.admitted);
    const second = await admit();
    assert.equal(second.admitted, false);
    assert.ok(!second.admitted && second.status === 409);
    assert.deepEqual(!second.admitted && second.body, {
      error: 'RUN_IN_PROGRESS',
      message: 'A dataset is already running in this workspace.',
      jobId: first.job.id,
    });
  });

  /**
   * The regression this module exists for. With the database asked *before* the
   * slot was claimed, both of these came back 202 — measured against a live
   * runtime, three attempts out of three.
   */
  it('admits exactly one of two arriving inside one database round trip', async () => {
    const jobs = new Map<string, Job>();
    const gate = deferred();
    let asked = 0;
    const admit = createRunAdmission<Job>({
      jobs,
      create: job,
      refuse: async () => {
        asked += 1;
        await gate.promise;
        return undefined;
      },
    });

    const both = Promise.all([admit(), admit()]);
    gate.release();
    const [a, b] = await both;

    const admitted = [a, b].filter((result) => result.admitted);
    assert.equal(admitted.length, 1, 'two runs must never share one database');
    const refused = [a, b].find((result) => !result.admitted);
    assert.ok(refused && !refused.admitted && refused.status === 409);
    // The loser never reaches the database: it was refused in the same tick.
    assert.equal(asked, 1);
  });

  it('gives two admissions in one millisecond different ids', async () => {
    const jobs = new Map<string, Job>();
    const admit = createRunAdmission<Job>({
      jobs,
      create: job,
      refuse: async () => undefined,
      // Frozen: `Date.now().toString(36)` alone handed both the same id.
      clock: () => 1_757_000_000_000,
    });

    const first = await admit();
    assert.ok(first.admitted);
    jobs.get(first.job.id)!.status = 'finished';
    const second = await admit();
    assert.ok(second.admitted);
    assert.notEqual(first.job.id, second.job.id);
    assert.equal(jobs.size, 2, 'the second must not have evicted the first');
  });

  it('hands the slot back when the database refuses, so the next run is not 409', async () => {
    const jobs = new Map<string, Job>();
    let refuseNext = true;
    const admit = createRunAdmission<Job>({
      jobs,
      create: job,
      refuse: async () =>
        refuseNext ? { status: 503, body: { error: 'DATABASE_UNREACHABLE' } } : undefined,
    });

    const refused = await admit();
    assert.equal(refused.admitted, false);
    assert.ok(!refused.admitted && refused.status === 503);
    assert.equal(jobs.size, 0, 'a refused run must leave no `running` job behind');

    refuseNext = false;
    const next = await admit();
    assert.equal(next.admitted, true, 'the next run must not be refused by a ghost');
  });

  it('keeps the newest jobs and drops the oldest, bounded', async () => {
    const jobs = new Map<string, Job>();
    const admit = createRunAdmission<Job>({
      jobs,
      create: job,
      refuse: async () => undefined,
      keep: 3,
    });

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const admission = await admit();
      assert.ok(admission.admitted);
      ids.push(admission.job.id);
      jobs.get(admission.job.id)!.status = 'finished';
    }

    assert.equal(jobs.size, 3);
    assert.deepEqual([...jobs.keys()], ids.slice(-3));
  });
});

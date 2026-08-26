import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openStore, type StoredRun } from './history.js';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'statescope-runs-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ids carry a base36 millisecond prefix, which is what makes them sortable. */
function stored(id: string, extra: Partial<StoredRun['run']> = {}, outcome = 'clean'): StoredRun {
  return {
    run: {
      id,
      scenarioId: 'refund',
      datasetId: 'happy',
      coverage: 'full',
      startedAt: '2026-08-26T00:00:00.000Z',
      ...extra,
    },
    verdict: { outcome },
    variables: { run: id.slice(-6), payment_id: `pay_${id}` },
  } as StoredRun;
}

describe('the run store', () => {
  it('writes one file per run, readable only by its owner', async () => {
    const store = openStore(join(dir, 'a'));
    await store.save(stored('run_aaaa0001'));
    const files = await readdir(join(dir, 'a'));
    assert.deepEqual(files, ['run_aaaa0001.json']);
    assert.equal((await stat(join(dir, 'a', 'run_aaaa0001.json'))).mode & 0o777, 0o600);
  });

  it('leaves no temporary file behind', async () => {
    // Written then renamed, so a reader never sees half a file.
    const store = openStore(join(dir, 'tmp'));
    await store.save(stored('run_bbbb0001'));
    assert.deepEqual((await readdir(join(dir, 'tmp'))).filter((f) => f.endsWith('.tmp')), []);
  });

  it('reads back exactly what it stored', async () => {
    const store = openStore(join(dir, 'b'));
    const original = stored('run_cccc0001');
    await store.save(original);
    assert.deepEqual(await store.get('run_cccc0001'), original);
  });

  it('orders by id, which is chronological', async () => {
    // The base36 millisecond prefix sorts lexicographically, so readdir().sort()
    // is the index — and an index is one more thing that can disagree with the
    // directory it describes.
    const store = openStore(join(dir, 'c'));
    for (const id of ['run_m0000001', 'run_m0000003', 'run_m0000002']) await store.save(stored(id));
    assert.deepEqual((await store.list(10)).map((r) => r.id), [
      'run_m0000003',
      'run_m0000002',
      'run_m0000001',
    ]);
  });

  it('finds the newest run matching a filter', async () => {
    const store = openStore(join(dir, 'd'));
    await store.save(stored('run_n0000001', { datasetId: 'happy' }));
    await store.save(stored('run_n0000002', { datasetId: 'duplicate' }));
    await store.save(stored('run_n0000003', { datasetId: 'happy' }));
    assert.equal((await store.latest({ datasetId: 'happy' }))?.run.id, 'run_n0000003');
    assert.equal((await store.latest({ datasetId: 'duplicate' }))?.run.id, 'run_n0000002');
    assert.equal(await store.latest({ datasetId: 'nope' }), undefined);
  });

  it('will not offer a partial run to continue from', async () => {
    // A partial run's variables are a mixture of carried and fresh, so
    // continuing from one compounds whatever was already ambiguous.
    const store = openStore(join(dir, 'e'));
    await store.save(stored('run_p0000001', { coverage: 'full' }));
    await store.save(stored('run_p0000002', { coverage: 'partial' }));
    assert.equal((await store.latest({ coverage: 'full' }))?.run.id, 'run_p0000001');
    // Without the filter, the newest wins whatever its coverage.
    assert.equal((await store.latest())?.run.id, 'run_p0000002');
  });

  it('keeps only the newest N', async () => {
    const store = openStore(join(dir, 'f'), { keep: 3 });
    for (let i = 1; i <= 6; i++) await store.save(stored(`run_q000000${i}`));
    const kept = (await store.list(20)).map((r) => r.id);
    assert.deepEqual(kept, ['run_q0000006', 'run_q0000005', 'run_q0000004']);
  });

  it('stores nothing at all when keep is zero', async () => {
    const store = openStore(join(dir, 'g'), { keep: 0 });
    await store.save(stored('run_r0000001'));
    await assert.rejects(readdir(join(dir, 'g')));
    assert.equal(await store.get('run_r0000001'), undefined);
  });

  it('survives a corrupt file rather than failing the run in progress', async () => {
    // This is history. The run that matters is the one happening now.
    const store = openStore(join(dir, 'h'));
    await store.save(stored('run_s0000001'));
    await writeFile(join(dir, 'h', 'run_s0000002.json'), 'not json at all', 'utf8');
    const listed = await store.list(10);
    assert.deepEqual(listed.map((r) => r.id), ['run_s0000001']);
    assert.equal(await store.get('run_s0000002'), undefined);
    assert.equal((await store.latest())?.run.id, 'run_s0000001');
  });

  it('reports an empty or missing directory as empty', async () => {
    const store = openStore(join(dir, 'never-created'));
    assert.deepEqual(await store.list(10), []);
    assert.equal(await store.latest(), undefined);
    assert.equal(await store.get('anything'), undefined);
  });

  it('carries the variables a later run needs', async () => {
    // The whole reason the store exists: --only reuses these, and a fresh
    // {{run}} paired with an old payment id is not a replay of anything.
    const store = openStore(join(dir, 'i'));
    await store.save(stored('run_t0000001'));
    const back = await store.get('run_t0000001');
    assert.equal((back as { variables: Record<string, string> }).variables['payment_id'], 'pay_run_t0000001');
  });
});

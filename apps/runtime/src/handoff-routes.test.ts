/**
 * `/api/handoff/targets` and `/api/handoff/open`, over a real Fastify.
 *
 * `tuplescope handoff enable … --i-know-this-is-not-local` says of its warning
 * "This will be reprinted every time it is used". Measured in round 3, nothing
 * reprinted it: a remote binding's `standing` was the same line a loopback one
 * got, and opening a row returned a bare URL. The open is the use, so the
 * banner has to be in what the open returns, every time.
 */

import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ChangeSet, Run } from '@tuplescope/core';
import { visible } from '@tuplescope/core';
import { HANDOFF_POLICY_VERSION } from '@tuplescope/handoff';
import { registerHandoffRoutes } from './handoff-routes.js';

const RENDERING = {
  DateStyle: 'ISO, MDY',
  TimeZone: 'UTC',
  bytea_output: 'hex',
  IntervalStyle: 'iso_8601',
  extra_float_digits: '1',
};

const changes: ChangeSet = {
  captureMethod: 'mvcc-xmin',
  detection: 'write',
  fidelity: 'net',
  scope: {
    schema: 'public',
    database: 'payments',
    allTables: true,
    tables: [{ table: 'wallets', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' }],
  },
  changes: [
    {
      table: 'wallets',
      key: { columns: [{ column: 'id', value: visible('text', 'wal_demo') }], token: 't' },
      kind: 'update',
      before: null,
      after: null,
      changedColumns: [],
      visibleColumns: [],
      hasWrite: true,
    },
  ],
  rendering: RENDERING,
  warnings: [],
  durationMs: 1,
} as unknown as ChangeSet;

const run = {
  id: 'run_1',
  scenarioId: 's',
  startedAt: '2026-01-01T00:00:00.000Z',
  coverage: 'full',
  variables: {},
  steps: [{ stepId: 'step_1', name: 'a step', request: { method: 'POST', url: 'http://x/y' }, changes, assertions: [] }],
} as unknown as Run;

let dir: string;
let app: FastifyInstance;
const opened: string[] = [];

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ts-handoff-routes-')));
  const grants = [{ workspace: dir, approvedAt: '', approvedBy: '', policyVersion: HANDOFF_POLICY_VERSION }];
  const configPath = join(dir, 'handoff.json');
  await writeFile(
    configPath,
    JSON.stringify({
      v: 1,
      bindings: {
        far: { preset: 'adminer-url', origin: 'https://adminer.example.com', server: 'db:5432', username: 'postgres', grants },
        near: { preset: 'adminer-url', origin: 'http://127.0.0.1:8080', server: 'db:5432', username: 'postgres', grants },
      },
    }),
  );
  app = Fastify();
  registerHandoffRoutes(app, {
    workspaceRoot: dir,
    connectionString: 'postgresql://postgres@127.0.0.1:5433/payments',
    findRun: (id) => (id === run.id ? run : undefined),
    openUrl: async (url) => {
      opened.push(url);
    },
    configPath,
  });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

const open = (alias: string) =>
  app.inject({
    method: 'POST',
    url: '/api/handoff/open',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ runId: 'run_1', stepId: 'step_1', changeIndex: 0, alias }),
  });

describe('a non-loopback binding, as the runtime serves it', () => {
  it('carries the banner in its standing line, and says so separately', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/handoff/targets' });
    const targets = (JSON.parse(response.body) as { targets: Array<Record<string, unknown>> }).targets;
    const far = targets.find((t) => t['alias'] === 'far')!;
    const near = targets.find((t) => t['alias'] === 'near')!;
    assert.match(String(far['standing']), /⚠ adminer\.example\.com is not loopback/);
    assert.match(String(far['banner']), /not loopback/);
    assert.doesNotMatch(String(near['standing']), /not loopback/);
    assert.equal(near['banner'], null);
  });

  it('reprints the banner on every open, not only the first', async () => {
    opened.length = 0;
    for (let i = 0; i < 2; i += 1) {
      const response = await open('far');
      assert.equal(response.statusCode, 200, response.body);
      const body = JSON.parse(response.body) as { kind: string; banner?: string };
      assert.equal(body.kind, 'url');
      assert.match(String(body.banner), /adminer\.example\.com is not loopback/);
    }
    assert.equal(opened.length, 2);
  });

  it('adds nothing for a loopback binding', async () => {
    const response = await open('near');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((JSON.parse(response.body) as { banner?: string }).banner, undefined);
  });
});

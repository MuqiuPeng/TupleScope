/**
 * `POST /api/assertions` — over a real Fastify, against a real scenario file.
 *
 * The defect this pins: a request with all four fields and an unknown
 * scenario id was answered "scenarioId, datasetId, stepId and expression are
 * all required" — a sentence about the request's shape, sent back for a
 * request whose shape was fine.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerAssertionRoute } from './assertion-route.js';

const SCENARIO = `version: 1
id: probe
title: Probe
datasets:
  - id: happy
    label: A. Happy
    steps:
      - id: s1
        name: First step
        request: { method: GET, path: /health }
        assert:
          - response.status == 200
`;

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tuplescope-assertion-route-'));
  dirs.push(dir);
  const file = join(dir, 'probe.yaml');
  await writeFile(file, SCENARIO, 'utf8');
  let reloads = 0;
  const app = Fastify();
  registerAssertionRoute(app, {
    files: () => new Map([['probe', file]]),
    reload: async () => {
      reloads += 1;
    },
  });
  await app.ready();
  return { app, file, reloads: () => reloads };
}

/** Exactly what the page sends. */
const post = (payload: unknown) => ({
  method: 'POST' as const,
  url: '/api/assertions',
  headers: { 'content-type': 'application/json' },
  payload: JSON.stringify(payload),
});

describe('POST /api/assertions', () => {
  it('names an unknown scenario rather than calling the request malformed', async () => {
    const { app } = await setup();
    const response = await app.inject(
      post({ scenarioId: 'nope', datasetId: 'happy', stepId: 's1', expression: 'response.status == 200' }),
    );
    assert.equal(response.statusCode, 422, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'CANNOT_SAVE');
    assert.match(body.message, /No scenario `nope`/);
    assert.match(body.message, /Loaded: probe\./);
    assert.doesNotMatch(body.message, /all required/);
    await app.close();
  });

  it('names the field that is actually missing', async () => {
    const { app } = await setup();
    const response = await app.inject(post({ scenarioId: 'probe', datasetId: 'happy', stepId: 's1' }));
    assert.equal(response.statusCode, 400, response.body);
    assert.match(JSON.parse(response.body).message, /^Missing `expression`\./);
    await app.close();
  });

  it('reports an unknown step the same way as an unknown scenario', async () => {
    const { app } = await setup();
    const response = await app.inject(
      post({ scenarioId: 'probe', datasetId: 'happy', stepId: 'nope', expression: 'response.status == 200' }),
    );
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(JSON.parse(response.body).error, 'CANNOT_SAVE');
    await app.close();
  });

  it('writes the line into the file and re-reads the directory', async () => {
    const { app, file, reloads } = await setup();
    const response = await app.inject(
      post({ scenarioId: 'probe', datasetId: 'happy', stepId: 's1', expression: 'count(inserted(wallets)) == 1' }),
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.match(await readFile(file, 'utf8'), /- count\(inserted\(wallets\)\) == 1/);
    assert.equal(reloads(), 1);
    await app.close();
  });
});

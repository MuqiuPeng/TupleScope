/**
 * The loader's job is to turn a bad scenario file into a clear error at load
 * time. Everything it lets through becomes either a wrong result or a confusing
 * one mid-run, so these tests are mostly about what it refuses.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadScenario, loadScenarios, ScenarioLoadError } from './load.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tuplescope-load-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function write(body: string): Promise<string> {
  const path = join(dir, `s${counter++}.yaml`);
  await writeFile(path, body, 'utf8');
  return path;
}

const VALID = `
version: 1
id: refund
title: Refund
datasets:
  - id: happy
    label: A
    steps:
      - id: pay
        name: Pay
        request: { method: POST, path: /payments }
        assert:
          - response.status == 201
`;

const rejects = async (body: string, pattern: RegExp) =>
  assert.rejects(async () => loadScenario(await write(body)), (error: unknown) => {
    assert.ok(error instanceof ScenarioLoadError, `expected ScenarioLoadError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });

describe('loadScenario', () => {
  it('reads a valid file', async () => {
    const scenario = await loadScenario(await write(VALID));
    assert.equal(scenario.id, 'refund');
    assert.equal(scenario.datasets[0]!.steps[0]!.id, 'pay');
  });

  it('refuses an unknown format version', async () => {
    // The version field exists so a breaking change has somewhere to announce
    // itself. Ignoring it would defeat the point of having one.
    await rejects(VALID.replace('version: 1', 'version: 2'), /unsupported `version: 2`/);
    await rejects(VALID.replace('version: 1\n', ''), /unsupported `version: undefined`/);
  });

  it('refuses a scenario with no datasets', async () => {
    await rejects(`version: 1\nid: a\ntitle: A\ndatasets: []\n`, /at least one dataset/);
  });

  it('refuses a dataset with no steps', async () => {
    await rejects(
      `version: 1\nid: a\ntitle: A\ndatasets:\n  - id: d\n    label: D\n    steps: []\n`,
      /dataset `d` has no steps/,
    );
  });

  it('refuses duplicate dataset and step ids', async () => {
    await rejects(VALID + VALID.slice(VALID.indexOf('  - id: happy')), /two datasets share the id/);
    await rejects(
      VALID.replace(
        '      - id: pay\n        name: Pay\n        request: { method: POST, path: /payments }\n',
        '      - id: pay\n        name: Pay\n        request: { method: POST, path: /a }\n' +
          '      - id: pay\n        name: Pay again\n        request: { method: POST, path: /b }\n',
      ),
      /reuses step id `pay`/,
    );
  });

  it('refuses a step with no request, method or path', async () => {
    await rejects(VALID.replace('        request: { method: POST, path: /payments }\n', ''), /has no request/);
    await rejects(VALID.replace('method: POST, ', ''), /has no method/);
    await rejects(VALID.replace(', path: /payments', ''), /has no path/);
  });

  it('parses assertions at load time, so a typo is a config error', async () => {
    // The same typo found mid-run is an unevaluable result buried in a report.
    await rejects(
      VALID.replace('response.status == 201', 'response.status = 201'),
      /step `pay`.*use `==` to compare/s,
    );
    await rejects(
      VALID.replace('response.status == 201', 'frobnicate(payments)'),
      /unknown function `frobnicate`/,
    );
  });

  it('accepts assertions containing template placeholders', async () => {
    // Placeholders are not values yet at load time; the parse check must not
    // choke on them.
    const scenario = await loadScenario(
      await write(VALID.replace('response.status == 201', 'response.body.id == {{payment_id}}')),
    );
    assert.equal(scenario.datasets[0]!.steps[0]!.assert![0], 'response.body.id == {{payment_id}}');
  });

  it('explains the flow-mapping template trap', async () => {
    // Every scenario is full of {{placeholders}}, and the raw parser error for
    // this says nothing about them.
    await rejects(
      VALID.replace(
        '        request: { method: POST, path: /payments }',
        '        request: { method: POST, path: /payments/{{id}}/refund }',
      ),
      /Quote the value/,
    );
  });

  it('reports the file in the message', async () => {
    const path = await write('version: 1\nid: [unclosed\n');
    await assert.rejects(loadScenario(path), new RegExp(path.replace(/[/\\]/g, '.')));
  });
});

describe('loadScenarios', () => {
  it('loads every yaml in the directory, in a stable order', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'tuplescope-dir-'));
    try {
      await writeFile(join(folder, 'b.yaml'), VALID.replace('id: refund', 'id: b'), 'utf8');
      await writeFile(join(folder, 'a.yml'), VALID.replace('id: refund', 'id: a'), 'utf8');
      await writeFile(join(folder, 'notes.md'), '# ignored', 'utf8');
      const scenarios = await loadScenarios(folder);
      assert.deepEqual(scenarios.map((s) => s.id), ['a', 'b']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});

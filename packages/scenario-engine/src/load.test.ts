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

  it('accepts a placeholder inside a longer string literal, and in either predicate form', async () => {
    // `"PVT-{{x}}"` failed here as "unexpected trailing `placeholder`": every
    // placeholder was swapped for `"placeholder"`, quotes and all, inside the
    // literal as much as outside it.
    for (const assertion of [
      'single(inserted(payments)).after.reference == "PVT-{{x}}"',
      "single(inserted(payments)).after.reference == 'PVT-{{x}}-{{run}}'",
      'single(inserted(payments)).after.reference == "{{x}}"',
      'count(rows(payments, id = "{{x}}")) == 1',
      "count(inserted(payments).where(id = '{{x}}')) == 1",
      'count(inserted(payments).where(id = {{x}})) == 1',
    ]) {
      const scenario = await loadScenario(await write(VALID.replace('response.status == 201', `'${assertion.replace(/'/g, "''")}'`)));
      assert.equal(scenario.datasets[0]!.steps[0]!.assert![0], assertion);
    }
  });

  it('quotes the author\'s own text in a syntax error, not a rewrite of it', async () => {
    await rejects(
      VALID.replace('response.status == 201', 'response.body.id == {{x}} {{y}}'),
      /unexpected trailing `y` \(at offset 26 in `response\.body\.id == \{\{x\}\} \{\{y\}\}`\)/,
    );
    await assert.rejects(
      async () => loadScenario(await write(VALID.replace('response.status == 201', `'"PVT-{{x}}" "z"'`))),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /placeholder/);
        assert.match(String(error), /in `"PVT-\{\{x\}\}" "z"`/);
        return true;
      },
    );
  });

  it('refuses an unknown key at every level, and names the one it was probably meant to be', async () => {
    // Each of these loaded, listed and ran with the setting silently missing:
    // the step expected a success, the dataset reset nothing, the step checked
    // nothing — and a `handoff:` key did nothing at all.
    await rejects(`${VALID}handoff: dev-psql\n`, /: unknown key `handoff`$/);
    await rejects(VALID.replace('title: Refund', 'titl: Refund'), /unknown key `titl` — did you mean `title`\?/);
    await rejects(
      VALID.replace('    label: A\n', '    label: A\n    resetFrist: true\n'),
      /dataset `happy`: unknown key `resetFrist` — did you mean `resetFirst`\?/,
    );
    await rejects(
      VALID.replace('        name: Pay\n', '        name: Pay\n        expectStaus: 404\n'),
      /dataset `happy` step `pay`: unknown key `expectStaus` — did you mean `expectStatus`\?/,
    );
    await rejects(
      VALID.replace('        assert:\n', '        asert:\n'),
      /dataset `happy` step `pay`: unknown key `asert` — did you mean `assert`\?/,
    );
    await rejects(
      VALID.replace('path: /payments }', 'path: /payments, idempotencykey: k }'),
      /step `pay` request: unknown key `idempotencykey` — did you mean `idempotencyKey`\?/,
    );
    await rejects(
      VALID.replace('path: /payments }', 'path: /payments, retry: { attempts: 2, backofMs: 5 } }'),
      /step `pay` request\.retry: unknown key `backofMs` — did you mean `backoffMs`\?/,
    );
    await rejects(
      VALID.replace('datasets:\n', 'watch:\n  - { table: payments, wher: "id = 1" }\ndatasets:\n'),
      /watch 0: unknown key `wher` — did you mean `where`\?/,
    );
  });

  it('suggests the key when two letters are swapped, as a typist swaps them', async () => {
    // Plain Levenshtein charged a swap two, a third of a short key is one, and
    // each of these came back with no suggestion at all.
    await rejects(VALID.replace('title: Refund', 'titel: Refund'), /unknown key `titel` — did you mean `title`\?/);
    await rejects(
      VALID.replace('datasets:\n', 'watch:\n  - { table: payments, wehre: "id = 1" }\ndatasets:\n'),
      /watch 0: unknown key `wehre` — did you mean `where`\?/,
    );
    await rejects(
      VALID.replace('        name: Pay\n', '        nmae: Pay\n'),
      /step `pay`: unknown key `nmae` — did you mean `name`\?/,
    );
  });

  it('accepts every key the contract defines, and any name inside capture, headers and body', async () => {
    const full = `
version: 1
id: full
title: Full
why: every key the contract has
watch:
  - { table: payments, where: "id = 1", ignoreColumns: [updatedAt] }
ignoreColumns: [updatedAt]
maskColumns: [secret]
datasets:
  - id: d
    label: D
    note: n
    resetFirst: true
    steps:
      - id: s
        name: S
        expect: prose
        expectStatus: 201
        capture: { anyName: response.body.id }
        request:
          method: POST
          path: /p
          as: alice
          headers: { x-anything: v }
          idempotencyKey: k
          body: { whatever: { nested: true } }
          retry: { attempts: 1, backoffMs: 10 }
          followRedirects: false
          timeoutMs: 1000
        assert:
          - response.status == 201
`;
    const scenario = await loadScenario(await write(full));
    assert.equal(scenario.id, 'full');
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

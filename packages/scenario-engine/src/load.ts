/**
 * Reads scenario files off disk and rejects the ones that would fail confusingly
 * later. Validation is deliberately strict about the things whose absence would
 * surface as a wrong result rather than an error.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { parse as parseExpr } from '@tuplescope/expr';
import type { Dataset, HttpRequest, Scenario, Step, WatchSpec } from '@tuplescope/core';

export class ScenarioLoadError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ScenarioLoadError';
  }
}

export async function loadScenarios(directory: string): Promise<Scenario[]> {
  const entries = await readdir(directory);
  const files = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    scenarios.push(await loadScenario(join(directory, file)));
  }
  return scenarios;
}

export async function loadScenario(path: string): Promise<Scenario> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new ScenarioLoadError(explainYamlError(error), path);
  }
  return validate(parsed, path);
}

/**
 * Adds the missing half of one YAML error people will hit constantly.
 *
 * `path: /carts/{{cart_id}}/items` is fine in block style, but inside a flow
 * mapping `{ ... }` the `{{` opens a nested flow map and the parse fails with a
 * message about flow-map-start that says nothing about templates. Since every
 * scenario is full of templates, this is worth naming outright.
 */
function explainYamlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/flow-map-start|Unexpected flow-map/.test(message)) {
    return (
      `${message}\n\n` +
      'This usually means a {{placeholder}} sits inside a flow mapping. YAML reads ' +
      'the `{{` as the start of a nested map. Quote the value — ' +
      'path: "/carts/{{cart_id}}/items" — or write the request in block style.'
    );
  }
  return message;
}

/**
 * The keys each level of a scenario file may use, taken from the contract.
 *
 * Typed as `Record<keyof T, true>`, so a field added to packages/core's
 * scenario.ts fails this build until the loader knows it, and a name here that
 * the contract does not have fails it too. `capture` and `headers` are maps
 * whose keys are the author's own names, and `body` is whatever the API takes;
 * none of those is checked.
 */
const SCENARIO_KEYS: Record<keyof Scenario, true> = {
  version: true,
  id: true,
  title: true,
  why: true,
  watch: true,
  ignoreColumns: true,
  maskColumns: true,
  datasets: true,
};
const WATCH_KEYS: Record<keyof WatchSpec, true> = { table: true, where: true, ignoreColumns: true };
const DATASET_KEYS: Record<keyof Dataset, true> = {
  id: true,
  label: true,
  note: true,
  resetFirst: true,
  steps: true,
};
const STEP_KEYS: Record<keyof Step, true> = {
  id: true,
  name: true,
  request: true,
  capture: true,
  expect: true,
  expectStatus: true,
  assert: true,
};
const REQUEST_KEYS: Record<keyof HttpRequest, true> = {
  method: true,
  path: true,
  as: true,
  headers: true,
  idempotencyKey: true,
  body: true,
  retry: true,
  followRedirects: true,
  timeoutMs: true,
};
const RETRY_KEYS: Record<keyof NonNullable<HttpRequest['retry']>, true> = { attempts: true, backoffMs: true };

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validate(value: unknown, file: string): Scenario {
  const fail = (message: string): never => {
    throw new ScenarioLoadError(message, file);
  };
  // An unknown key is nearly always a typo, and silently accepting one means
  // the setting the author thought they applied simply did not happen:
  // `expectStaus: 404` left the step expecting a success, `resetFrist: true`
  // reset nothing, and `asert:` checked nothing while `ls` listed the step. A
  // `handoff:` key was accepted too, and did nothing a reader could see.
  const refuseUnknown = (
    mapping: Record<string, unknown>,
    known: Readonly<Record<string, true>>,
    where: string,
  ): void => {
    for (const key of Object.keys(mapping)) {
      if (Object.hasOwn(known, key)) continue;
      const suggestion = nearest(key, Object.keys(known));
      fail(`${where}unknown key \`${key}\`${suggestion ? ` — did you mean \`${suggestion}\`?` : ''}`);
    }
  };

  if (!isMapping(value)) return fail('not a YAML mapping');
  const doc = value;

  // Present from v0.1 so that a breaking change has somewhere to announce itself.
  if (doc['version'] !== 1) {
    return fail(`unsupported \`version: ${String(doc['version'])}\` — this build reads version 1`);
  }
  refuseUnknown(doc, SCENARIO_KEYS, '');
  if (Array.isArray(doc['watch'])) {
    for (const [index, spec] of doc['watch'].entries()) {
      if (isMapping(spec)) refuseUnknown(spec, WATCH_KEYS, `watch ${index}: `);
    }
  }
  for (const key of ['id', 'title'] as const) {
    if (typeof doc[key] !== 'string' || !doc[key]) return fail(`missing \`${key}\``);
  }
  if (!Array.isArray(doc['datasets']) || doc['datasets'].length === 0) {
    return fail('needs at least one dataset');
  }

  const ids = new Set<string>();
  for (const [index, entry] of (doc['datasets'] as unknown[]).entries()) {
    if (!entry || typeof entry !== 'object') return fail(`dataset ${index} is not a mapping`);
    const dataset = entry as Record<string, unknown>;
    const id = dataset['id'];
    refuseUnknown(dataset, DATASET_KEYS, `dataset ${typeof id === 'string' && id ? `\`${id}\`` : index}: `);
    if (typeof id !== 'string' || !id) return fail(`dataset ${index} has no id`);
    if (ids.has(id)) return fail(`two datasets share the id \`${id}\``);
    ids.add(id);
    if (!Array.isArray(dataset['steps']) || dataset['steps'].length === 0) {
      return fail(`dataset \`${id}\` has no steps`);
    }

    const stepIds = new Set<string>();
    for (const [stepIndex, stepEntry] of (dataset['steps'] as unknown[]).entries()) {
      if (!stepEntry || typeof stepEntry !== 'object') {
        return fail(`dataset \`${id}\` step ${stepIndex} is not a mapping`);
      }
      const step = stepEntry as Record<string, unknown>;
      const stepId = step['id'];
      const at = `dataset \`${id}\` step ${typeof stepId === 'string' && stepId ? `\`${stepId}\`` : stepIndex}`;
      refuseUnknown(step, STEP_KEYS, `${at}: `);
      if (typeof stepId !== 'string' || !stepId) return fail(`dataset \`${id}\` step ${stepIndex} has no id`);
      if (stepIds.has(stepId)) return fail(`dataset \`${id}\` reuses step id \`${stepId}\``);
      stepIds.add(stepId);
      // The renderer pads it into a column, so an absent one reached the user
      // as `TypeError: Cannot read properties of undefined (reading 'padEnd')`
      // — after the request had already been sent. `ls`, `check` and `show` all
      // accepted the file first.
      if (typeof step['name'] !== 'string' || !step['name']) {
        return fail(`dataset \`${id}\` step \`${stepId}\` has no name`);
      }
      if (!step['request'] || typeof step['request'] !== 'object') {
        return fail(`step \`${stepId}\` has no request`);
      }
      const request = step['request'] as Record<string, unknown>;
      refuseUnknown(request, REQUEST_KEYS, `${at} request: `);
      if (isMapping(request['retry'])) refuseUnknown(request['retry'], RETRY_KEYS, `${at} request.retry: `);
      if (typeof request['method'] !== 'string') return fail(`step \`${stepId}\` has no method`);
      if (typeof request['path'] !== 'string') return fail(`step \`${stepId}\` has no path`);

      // Parse assertions now. A typo found at load time is a config error; the
      // same typo found mid-run is an unevaluable result buried in a report.
      //
      // Parsed as written. The lexer reads a bare `{{name}}` as a variable and
      // one inside a literal as text — the same boundaries the run templates
      // by — so there is nothing to substitute. Substituting `"placeholder"`
      // for every one broke any placeholder inside a longer literal and then
      // quoted the rewrite back: `"PVT-{{x}}"` failed as "unexpected trailing
      // `placeholder`" in `"PVT-"placeholder""`, a word and a source the
      // author never wrote.
      for (const source of (step['assert'] as unknown[] | undefined) ?? []) {
        if (typeof source !== 'string') return fail(`step \`${stepId}\` has a non-string assertion`);
        try {
          parseExpr(source);
        } catch (error) {
          return fail(
            `step \`${stepId}\`: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  return doc as unknown as Scenario;
}

/**
 * Cheap edit distance, only to turn `expectStaus` into a useful suggestion.
 *
 * The workspace loader's idiom (packages/workspace/src/config.ts), copied
 * rather than imported: this package does not depend on that one, and a
 * suggestion is not worth a dependency. The distance is not the workspace's;
 * see `editDistance`.
 */
function nearest(input: string, candidates: ReadonlyArray<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(input.toLowerCase(), name.toLowerCase());
    if (!best || distance < best.distance) best = { name, distance };
  }
  // Beyond a third of the word, a "suggestion" is noise.
  return best && best.distance <= Math.max(1, Math.floor(input.length / 3)) ? best.name : undefined;
}

/**
 * Optimal-string-alignment distance: Levenshtein, plus a swap of two adjacent
 * characters counted as one edit.
 *
 * Plain Levenshtein charges a swap two, and with the threshold at a third of
 * the word a short key never got its suggestion: `titel`, `wehre` and `nmae`
 * came back with no "did you mean" (measured). A swap is the commonest typing
 * mistake there is, which is why evaluate.ts's `close()` uses Damerau too.
 */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

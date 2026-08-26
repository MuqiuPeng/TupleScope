/**
 * Reads scenario files off disk and rejects the ones that would fail confusingly
 * later. Validation is deliberately strict about the things whose absence would
 * surface as a wrong result rather than an error.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { parse as parseExpr } from '@statescope/expr';
import type { Scenario } from '@statescope/core';

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

function validate(value: unknown, file: string): Scenario {
  const fail = (message: string): never => {
    throw new ScenarioLoadError(message, file);
  };
  if (!value || typeof value !== 'object') return fail('not a YAML mapping');
  const doc = value as Record<string, unknown>;

  // Present from v0.1 so that a breaking change has somewhere to announce itself.
  if (doc['version'] !== 1) {
    return fail(`unsupported \`version: ${String(doc['version'])}\` — this build reads version 1`);
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
      if (typeof stepId !== 'string' || !stepId) return fail(`dataset \`${id}\` step ${stepIndex} has no id`);
      if (stepIds.has(stepId)) return fail(`dataset \`${id}\` reuses step id \`${stepId}\``);
      stepIds.add(stepId);
      if (!step['request'] || typeof step['request'] !== 'object') {
        return fail(`step \`${stepId}\` has no request`);
      }
      const request = step['request'] as Record<string, unknown>;
      if (typeof request['method'] !== 'string') return fail(`step \`${stepId}\` has no method`);
      if (typeof request['path'] !== 'string') return fail(`step \`${stepId}\` has no path`);

      // Parse assertions now. A typo found at load time is a config error; the
      // same typo found mid-run is an unevaluable result buried in a report.
      for (const source of (step['assert'] as unknown[] | undefined) ?? []) {
        if (typeof source !== 'string') return fail(`step \`${stepId}\` has a non-string assertion`);
        try {
          parseExpr(source.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, '"placeholder"'));
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

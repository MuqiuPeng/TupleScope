/**
 * Writing an assertion back into a scenario file.
 *
 * Scenarios are hand-authored YAML that people explain themselves in, so this
 * edits the source *text* at a computed offset rather than re-serialising the
 * document. Re-serialising works and preserves comments, but it also unfolds
 * block scalars and re-pads flow collections — so the first time someone
 * clicked "keep this", their whole file would reformat and show up in git as a
 * large unrelated diff. That is how a helpful feature teaches people not to use
 * it.
 *
 * `parseDocument` is still what locates the insertion point; only the write is
 * textual.
 */

import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { parse as parseExpr } from '@statescope/expr';

export class ScenarioSaveError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'ScenarioSaveError';
  }
}

export interface AssertionEdit {
  file: string;
  datasetId: string;
  stepId: string;
  expression: string;
}

interface Located {
  source: string;
  step: YAML.YAMLMap;
  asserts: YAML.YAMLSeq | undefined;
}

function locate(source: string, edit: AssertionEdit): Located {
  const fail = (message: string): never => {
    throw new ScenarioSaveError(message, edit.file);
  };

  const doc = YAML.parseDocument(source);
  if (doc.errors.length > 0) {
    return fail(`will not edit a file that does not parse: ${doc.errors[0]!.message}`);
  }

  const datasets = doc.get('datasets');
  if (!YAML.isSeq(datasets)) return fail('has no datasets list');

  const dataset = datasets.items.find((item) => YAML.isMap(item) && item.get('id') === edit.datasetId);
  if (!YAML.isMap(dataset)) return fail(`has no dataset \`${edit.datasetId}\``);

  const steps = dataset.get('steps');
  if (!YAML.isSeq(steps)) return fail(`dataset \`${edit.datasetId}\` has no steps`);

  const step = steps.items.find((item) => YAML.isMap(item) && item.get('id') === edit.stepId);
  if (!YAML.isMap(step)) return fail(`dataset \`${edit.datasetId}\` has no step \`${edit.stepId}\``);

  const asserts = step.get('assert');
  return { source, step, asserts: YAML.isSeq(asserts) ? asserts : undefined };
}

/** Existing assertion strings, in file order. */
function listOf(asserts: YAML.YAMLSeq | undefined): string[] {
  if (!asserts) return [];
  return asserts.items.map((item) => String(YAML.isScalar(item) ? item.value : item));
}

/** Column at which the line containing `offset` starts its first non-space character. */
function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  return match ? match[0] : '';
}

/** End of the line that `offset` falls on, excluding the newline itself. */
function endOfLine(source: string, offset: number): number {
  const next = source.indexOf('\n', offset);
  return next === -1 ? source.length : next;
}

/** Start offset of a node, from the range the parser recorded. */
function startOf(node: unknown): number {
  const range = (node as { range?: [number, number, number] }).range;
  if (!range) throw new Error('node has no source range');
  return range[0];
}

/**
 * Appends one assertion to one step, creating the `assert:` list if needed.
 *
 * Returns `added: false` when the expression is already there — clicking the
 * same candidate twice should be a no-op, not a duplicate line.
 */
export async function addAssertion(
  edit: AssertionEdit,
): Promise<{ added: boolean; assertions: string[] }> {
  // Reject a bad expression before touching the file, so a typo cannot leave a
  // scenario that no longer loads.
  try {
    parseExpr(edit.expression.replace(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/g, '"placeholder"'));
  } catch (error) {
    throw new ScenarioSaveError(
      `refusing to write an assertion that does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
      edit.file,
    );
  }

  const source = await readFile(edit.file, 'utf8');
  const { step, asserts } = locate(source, edit);
  const existing = listOf(asserts);
  if (existing.includes(edit.expression)) return { added: false, assertions: existing };

  let insertAt: number;
  let text: string;

  if (asserts && asserts.items.length > 0) {
    // After the last item, at the same indent.
    const last = asserts.items[asserts.items.length - 1]!;
    const itemStart = startOf(last);
    const dash = source.lastIndexOf('-', itemStart);
    const indent = indentAt(source, dash);
    insertAt = endOfLine(source, itemStart);
    text = `\n${indent}- ${edit.expression}`;
  } else {
    // No list yet: put `assert:` after the step's last key, indented to match
    // its siblings.
    const lastPair = step.items[step.items.length - 1]!;
    const keyStart = startOf(lastPair.key);
    const indent = indentAt(source, keyStart);
    const valueEnd = (lastPair.value as { range?: [number, number, number] } | null)?.range?.[1];
    insertAt = endOfLine(source, valueEnd ?? keyStart);
    text = `\n${indent}assert:\n${indent}  - ${edit.expression}`;
  }

  const updated = `${source.slice(0, insertAt)}${text}${source.slice(insertAt)}`;
  await verify(updated, edit, [...existing, edit.expression]);
  await writeFile(edit.file, updated, 'utf8');
  return { added: true, assertions: [...existing, edit.expression] };
}

/** Removes one assertion, for undoing a promotion that turned out to be wrong. */
export async function removeAssertion(
  edit: AssertionEdit,
): Promise<{ removed: boolean; assertions: string[] }> {
  const source = await readFile(edit.file, 'utf8');
  const { asserts } = locate(source, edit);
  const existing = listOf(asserts);
  if (!asserts) return { removed: false, assertions: [] };

  const index = existing.indexOf(edit.expression);
  if (index === -1) return { removed: false, assertions: existing };

  const item = asserts.items[index]!;
  const itemStart = startOf(item);
  const dash = source.lastIndexOf('-', itemStart);
  const lineStart = source.lastIndexOf('\n', dash) + 1;
  const lineEnd = endOfLine(source, itemStart);

  let cutFrom = lineStart;
  let cutTo = lineEnd + 1;

  // Removing the only item would leave a dangling `assert:` key, which is not
  // valid for a list that must have entries — take the key with it.
  if (existing.length === 1) {
    const keyLine = source.lastIndexOf('\n', source.lastIndexOf('assert:', lineStart)) + 1;
    cutFrom = keyLine;
  }
  if (cutTo > source.length) cutTo = source.length;

  const remaining = existing.filter((e) => e !== edit.expression);
  const updated = source.slice(0, cutFrom) + source.slice(cutTo);
  await verify(updated, edit, remaining);
  await writeFile(edit.file, updated, 'utf8');
  return { removed: true, assertions: remaining };
}

/**
 * Re-reads the edited text before it is written.
 *
 * A textual splice is fast and lossless but it is not structurally aware, so
 * this confirms the result still parses and still says what it should. Writing
 * a broken scenario file would be much worse than refusing the edit.
 */
async function verify(updated: string, edit: AssertionEdit, expected: string[]): Promise<void> {
  let located: Located;
  try {
    located = locate(updated, edit);
  } catch (error) {
    throw new ScenarioSaveError(
      `the edit would have produced a file that no longer loads (${
        error instanceof Error ? error.message : String(error)
      })`,
      edit.file,
    );
  }
  const actual = listOf(located.asserts);
  if (actual.length !== expected.length || actual.some((a, i) => a !== expected[i])) {
    throw new ScenarioSaveError(
      `the edit would have produced the wrong assertions (got ${JSON.stringify(actual)}, ` +
        `wanted ${JSON.stringify(expected)}) — refusing to write`,
      edit.file,
    );
  }
}

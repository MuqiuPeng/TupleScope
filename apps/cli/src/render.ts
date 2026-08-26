/**
 * The terminal rendering.
 *
 * This product's entire value is showing what a database did, so the diff grid
 * is not decoration — it is the output. Two constraints shape all of it.
 *
 * A real table has forty columns and a real insert has a hundred rows, so
 * everything is capped, and every cap says out loud what it hid and which flag
 * shows it. Silent truncation in a tool whose claim is "exactly what changed"
 * would be the worst possible failure.
 *
 * And every glyph is accompanied by a word, on the same line or the one below.
 * The output has to survive NO_COLOR, a screenshot pasted into a ticket, and a
 * reader who cannot distinguish red from green.
 */

import type {
  AssertionResult,
  ChangeSet,
  LocatedWarning,
  RowChange,
  RunVerdict,
  StepResult,
  Value,
} from '@statescope/core';

// ─── style ────────────────────────────────────────────────────────────────────

export interface Style {
  color: boolean;
  ascii: boolean;
  width: number;
}

const CODES = {
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
  amber: '[33m',
  reset: '[0m',
} as const;

export type Colour = keyof Omit<typeof CODES, 'reset'>;

export function paint(style: Style, colour: Colour, text: string): string {
  return style.color ? `${CODES[colour]}${text}${CODES.reset}` : text;
}

/** Visible width, ignoring the escape sequences `padEnd` would otherwise count. */
export function widthOf(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '').length;
}

function pad(text: string, to: number): string {
  return text + ' '.repeat(Math.max(0, to - widthOf(text)));
}

function padStart(text: string, to: number): string {
  return ' '.repeat(Math.max(0, to - widthOf(text))) + text;
}

/**
 * Glyphs, each paired with a word by the caller.
 *
 * `--ascii` exists for terminals and CI log viewers that mangle the rest.
 */
export function glyph(style: Style, kind: 'pass' | 'fail' | 'undecided' | 'refused' | 'warn' | 'notrun'): string {
  const unicode = { pass: '✓', fail: '✗', undecided: '?', refused: '~', warn: '!', notrun: '·' };
  const ascii = { pass: '[ok]', fail: '[FAIL]', undecided: '[?]', refused: '[~]', warn: '[!]', notrun: '[-]' };
  const colour: Record<string, Colour> = {
    pass: 'green',
    fail: 'red',
    undecided: 'yellow',
    refused: 'amber',
    warn: 'cyan',
    notrun: 'dim',
  };
  return paint(style, colour[kind]!, (style.ascii ? ascii : unicode)[kind]);
}

const arrow = (style: Style): string => (style.ascii ? '->' : '→');

// ─── values ───────────────────────────────────────────────────────────────────

const MAX_VALUE_BYTES = 200;

export function renderValue(style: Style, value: Value | undefined, room: number): string {
  if (!value || value.text === null) return paint(style, 'dim', 'NULL');
  // Newlines would break the grid; a value that contains one still has to be
  // recognisable, so it collapses rather than disappearing.
  let text = value.text.replace(/\n/g, style.ascii ? '\\n' : '⏎');
  const bytes = Buffer.byteLength(value.text, 'utf8');
  if (bytes > MAX_VALUE_BYTES) {
    text = `${text.slice(0, Math.max(8, room - 12))}…${style.ascii ? `(${bytes}B)` : `⟨${bytes}B⟩`}`;
  } else if (widthOf(text) > room && room > 4) {
    text = `${text.slice(0, room - 1)}…`;
  }
  return text;
}

/** Keys can be long ids; the middle is the part that carries no information. */
export function renderKey(change: RowChange, style: Style): string {
  if (!change.key) return paint(style, 'dim', '(unkeyed)');
  const joined = change.key.columns.map((c) => c.value.text ?? 'NULL').join('·');
  if (joined.length <= 14) return joined;
  return `${joined.slice(0, 8)}…${joined.slice(-5)}`;
}

// ─── jsonb ────────────────────────────────────────────────────────────────────

const JSON_TYPES = new Set(['json', 'jsonb']);

interface Leaf {
  path: string;
  before?: unknown;
  after?: unknown;
}

/**
 * A key-path diff, rather than two ellipsised blobs.
 *
 * The engine already compares jsonb structurally, so it knows exactly which
 * leaf moved. Printing the whole document and letting the reader diff it by eye
 * would throw that away at the last step.
 */
export function jsonLeaves(before: unknown, after: unknown, prefix = ''): Leaf[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];

  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) => jsonLeaves(before[key], after[key], `${prefix}.${key}`));
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Leaf[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      out.push(...jsonLeaves(before[i], after[i], `${prefix}[${i}]`));
    }
    return out;
  }
  return [
    {
      path: prefix || '.',
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    },
  ];
}

function renderLeaf(style: Style, leaf: Leaf): string {
  const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));
  if (leaf.before === undefined) return `${paint(style, 'dim', '(added)')} ${show(leaf.after)}`;
  if (leaf.after === undefined) return `${show(leaf.before)} ${arrow(style)} ${paint(style, 'dim', '(removed)')}`;
  return `${show(leaf.before)} ${arrow(style)} ${show(leaf.after)}`;
}

// ─── the diff grid ────────────────────────────────────────────────────────────

export interface DiffOptions {
  style: Style;
  /** Columns per inserted/deleted row before the rest are summarised. */
  columns: number | 'all';
  /** Rows per table. A hundred-row insert is exactly when you do not want a hundred lines. */
  maxRows: number;
  maxTables: number;
  /** Column names mentioned in this step's assertions, ranked first. */
  interesting: ReadonlySet<string>;
  indent: string;
}

/**
 * Ranks columns by how likely the reader is to care.
 *
 * A column named in one of this step's own assertions comes first: the reader
 * is looking at this diff *because* of that assertion.
 */
function rankColumns(change: RowChange, options: DiffOptions): string[] {
  const row = change.after ?? change.before ?? {};
  const keys = new Set(change.key?.columns.map((c) => c.column) ?? []);
  const groups: string[][] = [[], [], [], []];
  for (const name of Object.keys(row).sort()) {
    if (options.interesting.has(name)) groups[0]!.push(name);
    else if (keys.has(name)) groups[1]!.push(name);
    else if (row[name]?.text !== null) groups[2]!.push(name);
    else groups[3]!.push(name);
  }
  return groups.flat();
}

const MAX_UPDATE_COLUMNS = 8;
const MAX_JSON_PATHS = 6;

export function renderDiff(changes: ChangeSet, options: DiffOptions): string[] {
  const { style, indent } = options;
  const byTable = new Map<string, RowChange[]>();
  for (const change of changes.changes) {
    if (!byTable.has(change.table)) byTable.set(change.table, []);
    byTable.get(change.table)!.push(change);
  }
  if (byTable.size === 0) return [];

  const nameWidth = Math.min(18, Math.max(...[...byTable.keys()].map((t) => t.length)));
  // Measured across the whole diff, so every row's value column starts at the
  // same place. A fixed width lets one long id shove that row out of the grid.
  const keyWidth = Math.min(
    16,
    Math.max(4, ...changes.changes.map((c) => widthOf(renderKey(c, style)))),
  );
  const out: string[] = [];
  const tables = [...byTable.entries()];

  for (const [table, rows] of tables.slice(0, options.maxTables)) {
    const counts = { insert: 0, update: 0, delete: 0 };
    for (const row of rows) {
      if (row.kind === 'insert' || row.kind === 'entered-scope') counts.insert++;
      else if (row.kind === 'delete' || row.kind === 'left-scope') counts.delete++;
      else counts.update++;
    }
    const summary = [
      counts.insert ? `+${counts.insert} new` : '',
      counts.update ? `${counts.update} updated` : '',
      counts.delete ? `-${counts.delete}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    let first = true;
    for (const change of rows.slice(0, options.maxRows)) {
      const lead = pad(first ? table : '', nameWidth) + '  ' + pad(first ? summary : '', 11);
      first = false;
      const key = pad(renderKey(change, style), keyWidth);
      const prefix = `${indent}${lead} ${key} `;
      const room = Math.max(20, style.width - widthOf(prefix) - 12);

      const lines = change.kind === 'update'
        ? renderUpdate(change, options, room)
        : renderInsertOrDelete(change, options, room);

      if (lines.length === 0) {
        // The differentiator, stated in words at the row it happened to.
        out.push(`${prefix}${paint(style, 'dim', '· written, no visible change')}`);
        const hidden = change.changedColumns.filter((c) => !change.visibleColumns.includes(c));
        if (hidden.length > 0) {
          out.push(
            `${' '.repeat(widthOf(prefix))}${paint(style, 'dim', `only ${hidden.join(', ')} changed, which is ignored`)}`,
          );
        }
        continue;
      }
      const gutter = ' '.repeat(widthOf(prefix));
      out.push(`${prefix}${lines[0]}`);
      for (const line of lines.slice(1)) out.push(`${gutter}${line}`);
    }

    if (rows.length > options.maxRows) {
      out.push(
        `${indent}${' '.repeat(nameWidth + 2)}${paint(style, 'dim', `(+${rows.length - options.maxRows} more rows · --diff all)`)}`,
      );
    }

  }

  if (tables.length > options.maxTables) {
    out.push(
      `${indent}${paint(style, 'dim', `(+${tables.length - options.maxTables} more tables · --diff all)`)}`,
    );
  }
  return out;
}

function renderUpdate(change: RowChange, options: DiffOptions, room: number): string[] {
  const { style } = options;
  const shown = change.visibleColumns.slice(0, MAX_UPDATE_COLUMNS);
  const nameWidth = Math.max(0, ...shown.map((c) => c.length));
  const lines: string[] = [];

  for (const column of shown) {
    const before = change.before?.[column];
    const after = change.after?.[column];

    if (JSON_TYPES.has(after?.pgType ?? before?.pgType ?? '')) {
      const leaves = safeLeaves(before, after);
      if (leaves.length > 0) {
        const pathWidth = Math.max(...leaves.slice(0, MAX_JSON_PATHS).map((l) => l.path.length));
        leaves.slice(0, MAX_JSON_PATHS).forEach((leaf, index) => {
          lines.push(
            `${pad(index === 0 ? column : '', nameWidth)}  ${pad(leaf.path, pathWidth)}  ${renderLeaf(style, leaf)}`,
          );
        });
        if (leaves.length > MAX_JSON_PATHS) {
          lines.push(
            `${' '.repeat(nameWidth)}  ${paint(style, 'dim', `(+${leaves.length - MAX_JSON_PATHS} more paths)`)}`,
          );
        }
        continue;
      }
    }

    // Right-align both sides on the arrow so a column of money reads as one.
    const left = renderValue(style, before, Math.floor(room / 2));
    const right = renderValue(style, after, Math.floor(room / 2));
    const cell = Math.max(widthOf(left), widthOf(right));
    lines.push(
      `${pad(column, nameWidth)}  ${padStart(left, cell)} ${arrow(style)} ${padStart(right, cell)}`,
    );
  }

  if (change.visibleColumns.length > MAX_UPDATE_COLUMNS) {
    lines.push(
      paint(style, 'dim', `(+${change.visibleColumns.length - MAX_UPDATE_COLUMNS} more changed columns · --columns all)`),
    );
  }
  return lines;
}

function renderInsertOrDelete(change: RowChange, options: DiffOptions, room: number): string[] {
  const { style } = options;
  const row = change.after ?? change.before ?? {};
  const ranked = rankColumns(change, options);
  const limit = options.columns === 'all' ? ranked.length : options.columns;
  const shown = ranked.slice(0, limit);
  const nameWidth = Math.max(0, ...shown.map((c) => c.length));

  const lines = shown.map((column) => {
    const value = row[column];
    if (JSON_TYPES.has(value?.pgType ?? '') && value?.text) {
      return `${pad(column, nameWidth)}  ${paint(style, 'dim', summariseJson(value.text))}`;
    }
    return `${pad(column, nameWidth)}  ${renderValue(style, value, room)}`;
  });

  if (ranked.length > shown.length) {
    lines.push(paint(style, 'dim', `(+${ranked.length - shown.length} more columns · --columns all)`));
  }
  return lines;
}

function summariseJson(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return `[${parsed.length}]`;
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed);
      return `{${keys.length} keys} ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}`;
    }
  } catch {
    /* not json after all */
  }
  return text.slice(0, 40);
}

function safeLeaves(before: Value | undefined, after: Value | undefined): Leaf[] {
  try {
    return jsonLeaves(
      before?.text ? JSON.parse(before.text) : undefined,
      after?.text ? JSON.parse(after.text) : undefined,
    );
  } catch {
    return [];
  }
}

// ─── assertions, steps, the summary ───────────────────────────────────────────

export function renderAssertion(style: Style, assertion: AssertionResult, indent: string): string[] {
  const kind =
    assertion.status === 'passed'
      ? 'pass'
      : assertion.status === 'failed'
        ? 'fail'
        : assertion.status === 'passed-as-refused'
          ? 'refused'
          : 'undecided';
  const head = `${indent}${glyph(style, kind)} ${assertion.source}`;
  if (assertion.status === 'passed' || assertion.status === 'passed-as-refused') return [head];

  if (assertion.status === 'failed') {
    return [head, `${indent}  ${paint(style, 'dim', `expected ${assertion.expected ?? '—'}, got ${assertion.actual ?? '—'}`)}`];
  }
  // The word matters more than the glyph: a reader who has only seen pass and
  // fail will file this as one of them unless told it is neither.
  return [
    head,
    `${indent}  ${paint(style, 'yellow', 'undecided')} ${paint(style, 'dim', '— this check did not run.')} ${assertion.reason ?? ''}`,
  ];
}

export function renderWarning(style: Style, warning: LocatedWarning, indent: string): string[] {
  const where = warning.source === 'baseline' ? 'baseline' : (warning.stepId ?? 'step');
  return [
    `${indent}${glyph(style, 'warn')} ${paint(style, warning.severity === 'error' ? 'yellow' : 'cyan', warning.code)}` +
      `${warning.table ? ` (${warning.table})` : ''} ${paint(style, 'dim', `· ${where}`)}`,
    `${indent}  ${paint(style, 'dim', warning.message)}`,
  ];
}

export function stepGlyph(style: Style, step: StepResult, verdict: RunVerdict): string {
  if (step.status === 'errored') return glyph(style, 'fail');
  if (step.status === 'skipped' || step.status === 'pending') return glyph(style, 'notrun');
  if (step.status === 'failed' || step.assertions.some((a) => a.status === 'failed')) {
    return glyph(style, 'fail');
  }
  if (
    verdict.policy.unevaluable === 'error' &&
    step.assertions.some((a) => a.status === 'unevaluable')
  ) {
    return glyph(style, 'undecided');
  }
  return glyph(style, 'pass');
}

/**
 * The closing block: the outcome, the exit code, and what the run did not prove.
 *
 * `proves: bounded` is printed even when the outcome is clean, because a
 * qualified green that reads as an unqualified one is the failure this whole
 * product is arranged against.
 */
export function renderSummary(style: Style, verdict: RunVerdict, exitCode: number): string[] {
  const word: Record<string, [Colour, string]> = {
    clean: ['green', 'clean'],
    failed: ['red', 'failed'],
    undecided: ['yellow', 'undecided'],
    errored: ['red', 'errored'],
  };
  const [colour, text] = word[verdict.outcome]!;
  const out = [
    '',
    `  outcome  ${paint(style, colour, text)}  ${paint(style, 'dim', `· ${verdict.reason}`)}`,
    `  checks   ${verdict.assertions.passed}/${verdict.assertions.total} passed` +
      (verdict.assertions.failed ? `, ${paint(style, 'red', `${verdict.assertions.failed} failed`)}` : '') +
      (verdict.assertions.unevaluable
        ? `, ${paint(style, 'yellow', `${verdict.assertions.unevaluable} undecided`)}`
        : ''),
  ];

  if (verdict.proves === 'bounded') {
    out.push(`  proves   ${paint(style, 'dim', 'bounded — this run does not establish everything it looks like it does:')}`);
    for (const bound of verdict.boundedBy) out.push(`             ${paint(style, 'dim', `· ${bound}`)}`);
  }
  out.push(`  exit     ${exitCode}`);
  return out;
}

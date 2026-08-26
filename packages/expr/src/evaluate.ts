/**
 * Evaluator for the selector language.
 *
 * Two rules shape everything here.
 *
 * The first is that an expression which cannot be *decided* must say so rather
 * than resolve to false. A mutation count evaluated against a value-comparing
 * ChangeSet, a `single()` that matched three rows, a table outside the watch
 * scope — each is `Unevaluable`, and the runner surfaces it as its own status.
 * A green run that could not have caught the failure is worse than no check.
 *
 * The second is that comparison happens under Postgres type semantics, never on
 * JS values: `numeric` compares as an exact decimal, `jsonb` structurally
 * (Postgres reorders object keys, so a string compare invents changes that did
 * not happen), `citext` case-insensitively.
 */

import type {
  ChangeSet,
  Detection,
  Expr,
  RowChange,
  Row,
  Temporal,
  Value,
} from '@statescope/core';
import { Decimal } from './decimal.js';

/** Raised when an expression cannot be decided. Never collapses into `false`. */
export class Unevaluable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Unevaluable';
  }
}

export interface EvalContext {
  changes: ChangeSet;
  response?: { status: number; headers: Record<string, string>; body: unknown };
  variables: Readonly<Record<string, string>>;
  /**
   * Fetches rows the ChangeSet does not contain because they did not change.
   * Supplied by the engine, backed by the adapter. Absent in pure unit tests,
   * in which case `rows()` sees only what changed.
   */
  lookupRows?: (table: string, predicate?: string) => ReadonlyArray<Row>;
}

type Eval =
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'selection'; rows: ReadonlyArray<RowChange> }
  | { kind: 'column'; values: ReadonlyArray<Value | null>; temporal: Temporal };

// ─── Value semantics ──────────────────────────────────────────────────────────

const JSON_TYPES = new Set(['json', 'jsonb']);
const NUMERIC_TYPES = new Set(['numeric', 'decimal', 'int2', 'int4', 'int8', 'float4', 'float8']);

/** Deep structural equality, key order insensitive — what jsonb actually needs. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ax = a as Record<string, unknown>;
  const bx = b as Record<string, unknown>;
  const keys = Object.keys(ax);
  if (keys.length !== Object.keys(bx).length) return false;
  return keys.every((k) => Object.hasOwn(bx, k) && jsonEqual(ax[k], bx[k]));
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a.text === null || b.text === null) return a.text === b.text;
  const type = a.pgType || b.pgType;
  if (JSON_TYPES.has(type)) {
    try {
      return jsonEqual(JSON.parse(a.text), JSON.parse(b.text));
    } catch {
      return a.text === b.text;
    }
  }
  if (NUMERIC_TYPES.has(type) && Decimal.isDecimal(a.text) && Decimal.isDecimal(b.text)) {
    return Decimal.parse(a.text).equals(Decimal.parse(b.text));
  }
  if (type === 'citext') return a.text.toLowerCase() === b.text.toLowerCase();
  return a.text === b.text;
}

function asDecimal(value: Value | null, what: string): Decimal {
  if (value?.text == null) throw new Unevaluable(`${what} is NULL, so it has no numeric value`);
  if (!Decimal.isDecimal(value.text)) {
    throw new Unevaluable(`${what} is \`${value.text}\`, which is not numeric`);
  }
  return Decimal.parse(value.text);
}

// ─── Predicates ───────────────────────────────────────────────────────────────

/**
 * Matches `col = 'x'` clauses joined by `and`. Deliberately not SQL: predicates
 * exist to pick a row out of a handful of observed changes, and letting this
 * grow into a query language is how the assertion layer stops being auditable.
 */
function matchesPredicate(row: Row | null, predicate: string): boolean {
  if (!row) return false;
  for (const clause of predicate.split(/\s+and\s+/i)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(clause);
    if (!m) throw new Unevaluable(`cannot read predicate \`${clause.trim()}\``);
    const [, column, rawLiteral] = m;
    const expected = rawLiteral!.replace(/^['"]|['"]$/g, '');
    const actual = row[column!];
    if (actual === undefined) throw new Unevaluable(`no column \`${column}\` to match on`);
    if (!valuesEqual(actual, { pgType: actual.pgType, text: expected })) return false;
  }
  return true;
}

function rowFor(change: RowChange, temporal: Temporal): Row | null {
  return temporal === 'before' ? change.before : change.after;
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

function requireDetection(changes: ChangeSet, needed: Detection, what: string): void {
  if (needed === 'write' && changes.detection !== 'write') {
    throw new Unevaluable(
      `${what} needs write detection, but this run captured with ` +
        `\`${changes.captureMethod}\` (${changes.detection} detection). ` +
        `A value comparison cannot tell a redundant write from no write at all.`,
    );
  }
}

function evaluate(expr: Expr, ctx: EvalContext): Eval {
  switch (expr.node) {
    case 'literal':
      return { kind: 'scalar', value: expr.value };

    case 'variable': {
      const value = ctx.variables[expr.name];
      if (value === undefined) throw new Unevaluable(`no variable \`${expr.name}\` was captured`);
      return { kind: 'scalar', value };
    }

    case 'response': {
      if (!ctx.response) throw new Unevaluable('this step has no response to read');
      if (expr.path === 'status') return { kind: 'scalar', value: ctx.response.status };
      const [head, ...rest] = expr.path.split('.');
      let cursor: unknown =
        head === 'body' ? ctx.response.body : head === 'headers' ? ctx.response.headers : undefined;
      if (cursor === undefined) throw new Unevaluable(`cannot read \`response.${expr.path}\``);
      for (const key of rest) {
        if (cursor === null || typeof cursor !== 'object') {
          throw new Unevaluable(`\`response.${expr.path}\` stops at \`${key}\``);
        }
        cursor = (cursor as Record<string, unknown>)[key];
      }
      if (cursor === undefined) return { kind: 'scalar', value: null };
      return {
        kind: 'scalar',
        value:
          typeof cursor === 'object' ? JSON.stringify(cursor) : (cursor as string | number | boolean),
      };
    }

    case 'select': {
      const { kind, table, predicate } = expr.selector;
      if (table && !inScope(ctx.changes, table)) {
        throw new Unevaluable(
          `table \`${table}\` is not being watched, so nothing can be asserted about it`,
        );
      }
      let rows = ctx.changes.changes.filter((c) => !table || c.table === table);
      if (kind === 'inserted') rows = rows.filter((c) => c.kind === 'insert' || c.kind === 'entered-scope');
      else if (kind === 'updated') rows = rows.filter((c) => c.kind === 'update');
      else if (kind === 'deleted') rows = rows.filter((c) => c.kind === 'delete' || c.kind === 'left-scope');
      if (predicate) {
        rows = rows.filter((c) => matchesPredicate(c.after ?? c.before, predicate));
      }
      return { kind: 'selection', rows };
    }

    case 'predicate': {
      const source = asSelection(evaluate(expr.source, ctx), 'where');
      return {
        kind: 'selection',
        rows: source.filter((c) => matchesPredicate(c.after ?? c.before, expr.predicate)),
      };
    }

    case 'column': {
      if (expr.temporal === null) {
        throw new Unevaluable(
          `\`${expr.column}\` needs a side: write .before.${expr.column}, ` +
            `.after.${expr.column}, or delta(...${expr.column}).`,
        );
      }
      const rows = asSelection(evaluate(expr.source, ctx), 'a column read');
      if (expr.temporal === 'delta') {
        const values = rows.map((change) => {
          const before = change.before?.[expr.column] ?? null;
          const after = change.after?.[expr.column] ?? null;
          const zero = Decimal.zero();
          const from = before ? asDecimal(before, `${change.table}.${expr.column} before`) : zero;
          const to = after ? asDecimal(after, `${change.table}.${expr.column} after`) : zero;
          const pgType = after?.pgType ?? before?.pgType ?? 'numeric';
          return { pgType, text: to.minus(from).toString() } satisfies Value;
        });
        return { kind: 'column', values, temporal: 'delta' };
      }
      const values = rows.map((change) => rowFor(change, expr.temporal!)?.[expr.column] ?? null);
      return { kind: 'column', values, temporal: expr.temporal };
    }

    case 'aggregate': {
      const source = evaluate(expr.source, ctx);
      switch (expr.fn) {
        case 'count': {
          const rows = asSelection(source, 'count');
          requireDetection(ctx.changes, 'write', 'counting mutations');
          return { kind: 'scalar', value: rows.length };
        }
        case 'single': {
          const rows = asSelection(source, 'single');
          if (rows.length !== 1) {
            throw new Unevaluable(
              `single() expected exactly one row, found ${rows.length}. ` +
                `Narrow it with a predicate, or use count()/sum() if many rows are intended.`,
            );
          }
          return { kind: 'selection', rows };
        }
        case 'sum': {
          const column = asColumn(source, 'sum');
          const total = column.values.reduce<Decimal>(
            (acc, v, i) => acc.plus(asDecimal(v, `value ${i}`)),
            Decimal.zero(),
          );
          return { kind: 'scalar', value: total.toString() };
        }
        case 'min':
        case 'max': {
          const column = asColumn(source, expr.fn);
          if (column.values.length === 0) throw new Unevaluable(`${expr.fn}() over an empty set`);
          const decimals = column.values.map((v, i) => asDecimal(v, `value ${i}`));
          const pick = decimals.reduce((a, b) =>
            (expr.fn === 'min' ? a.compare(b) <= 0 : a.compare(b) >= 0) ? a : b,
          );
          return { kind: 'scalar', value: pick.toString() };
        }
        case 'any':
          return { kind: 'scalar', value: asSelection(source, 'any').length > 0 };
        case 'all':
          throw new Unevaluable('all() is not available yet');
      }
      break;
    }

    case 'hasWrite': {
      const rows = asSelection(evaluate(expr.source, ctx), 'hasWrite');
      requireDetection(ctx.changes, 'write', 'hasWrite');
      return { kind: 'scalar', value: rows.some((c) => c.hasWrite) };
    }

    case 'isEmpty':
      return { kind: 'scalar', value: asSelection(evaluate(expr.source, ctx), 'isEmpty').length === 0 };

    case 'not': {
      const inner = evaluate(expr.operand, ctx);
      return { kind: 'scalar', value: !truthy(inner) };
    }

    case 'logical': {
      const left = truthy(evaluate(expr.left, ctx));
      if (expr.op === 'and' && !left) return { kind: 'scalar', value: false };
      if (expr.op === 'or' && left) return { kind: 'scalar', value: true };
      return { kind: 'scalar', value: truthy(evaluate(expr.right, ctx)) };
    }

    case 'compare':
      return { kind: 'scalar', value: compare(expr.op, evaluate(expr.left, ctx), evaluate(expr.right, ctx)) };
  }
  throw new Unevaluable('unsupported expression');
}

function inScope(changes: ChangeSet, table: string): boolean {
  return changes.scope.allTables || changes.scope.tables.some((t) => t.table === table);
}

function asSelection(value: Eval, what: string): ReadonlyArray<RowChange> {
  if (value.kind !== 'selection') throw new Unevaluable(`${what} needs a set of rows`);
  return value.rows;
}

function asColumn(value: Eval, what: string): Extract<Eval, { kind: 'column' }> {
  if (value.kind !== 'column') throw new Unevaluable(`${what} needs a column, e.g. ${what}(wallets.balance)`);
  return value;
}

function truthy(value: Eval): boolean {
  if (value.kind === 'selection') return value.rows.length > 0;
  if (value.kind === 'column') return value.values.length > 0;
  return value.value === true;
}

/** Renders any evaluated result for display in a failure message. */
export function render(value: Eval): string {
  if (value.kind === 'scalar') return value.value === null ? 'null' : String(value.value);
  if (value.kind === 'selection') return `${value.rows.length} row(s)`;
  if (value.values.length === 1) return value.values[0]?.text ?? 'null';
  return `[${value.values.map((v) => v?.text ?? 'null').join(', ')}]`;
}

function compare(op: string, left: Eval, right: Eval): boolean {
  const a = coerce(left);
  const b = coerce(right);
  if (op === '==' || op === '!=') {
    const equal = valuesEqual(a, b);
    return op === '==' ? equal : !equal;
  }
  const order = asDecimal(a, 'left side').compare(asDecimal(b, 'right side'));
  switch (op) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
  }
  throw new Unevaluable(`unknown operator \`${op}\``);
}

/** Reduces an evaluated result to the single value a comparison can use. */
function coerce(value: Eval): Value {
  if (value.kind === 'scalar') {
    if (value.value === null) return { pgType: 'text', text: null };
    if (typeof value.value === 'number') return { pgType: 'numeric', text: String(value.value) };
    if (typeof value.value === 'boolean') return { pgType: 'bool', text: String(value.value) };
    return {
      pgType: Decimal.isDecimal(value.value) ? 'numeric' : 'text',
      text: value.value,
    };
  }
  if (value.kind === 'column') {
    if (value.values.length !== 1) {
      throw new Unevaluable(
        `comparison needs one value, got ${value.values.length}. ` +
          `Wrap it in single(...) or sum(...).`,
      );
    }
    return value.values[0] ?? { pgType: 'text', text: null };
  }
  throw new Unevaluable('cannot compare a set of rows directly — use count() or single()');
}

/**
 * Entry point: evaluates a parsed expression to true/false.
 *
 * On a comparison, `actual` reports the left-hand side rather than the verdict.
 * "expected 1, got 2" tells you what to fix; "got false" makes you re-run the
 * query by hand to find out what happened, which is the failure mode this whole
 * tool exists to remove.
 */
export function evaluateAssertion(
  expr: Expr,
  ctx: EvalContext,
): { passed: boolean; actual: string; expected?: string } {
  const result = evaluate(expr, ctx);
  const passed = truthy(result);
  if (expr.node === 'compare' && !passed) {
    return {
      passed,
      actual: render(evaluate(expr.left, ctx)),
      expected: render(evaluate(expr.right, ctx)),
    };
  }
  return { passed, actual: render(result) };
}

export { evaluate as evaluateExpr };

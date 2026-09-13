/**
 * Parser for the selector language.
 *
 * Recursive descent, no dependencies. The grammar is deliberately small: this
 * language is a contract that v0.2's dashboards inherit, so every construct it
 * gains is one it can never drop.
 *
 *   or      := and ('or' and)*
 *   and     := cmp ('and' cmp)*
 *   cmp     := unary (('=='|'!='|'<='|'>='|'<'|'>') unary)?
 *   unary   := 'not' unary | postfix
 *   postfix := primary ('.' IDENT | '.' IDENT '(' args ')')*
 *   primary := NUMBER | STRING | 'true' | 'false' | 'null'
 *            | '{{' IDENT '}}' | IDENT '(' args ')' | IDENT | '(' or ')'
 */

import type { Expr, CompareOp, Selector, SelectorKind, Temporal } from '@tuplescope/core';
import { needsSide, parsePredicate } from './evaluate.js';

const SELECTOR_KINDS: ReadonlySet<string> = new Set([
  'changes',
  'inserted',
  'updated',
  'deleted',
  'rows',
]);
const AGGREGATES: ReadonlySet<string> = new Set([
  'single',
  'count',
  'sum',
  'min',
  'max',
  'any',
]);
const TEMPORALS: ReadonlySet<string> = new Set(['before', 'after', 'delta']);
const COMPARE_OPS: ReadonlySet<string> = new Set(['==', '!=', '<=', '>=', '<', '>']);

export class ExprSyntaxError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly position: number,
  ) {
    super(`${message} (at offset ${position} in \`${source}\`)`);
    this.name = 'ExprSyntaxError';
  }
}

interface Token {
  type: 'ident' | 'number' | 'string' | 'op' | 'var';
  text: string;
  pos: number;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // {{name}} — a captured or built-in variable.
    if (src.startsWith('{{', i)) {
      const end = src.indexOf('}}', i + 2);
      if (end === -1) throw new ExprSyntaxError('unterminated {{', src, i);
      out.push({ type: 'var', text: src.slice(i + 2, end).trim(), pos: i });
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          text += src[j + 1];
          j += 2;
          continue;
        }
        text += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprSyntaxError('unterminated string', src, i);
      out.push({ type: 'string', text, pos: i });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      out.push({ type: 'number', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_*]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_*]/.test(src[j]!)) j++;
      out.push({ type: 'ident', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (COMPARE_OPS.has(two)) {
      out.push({ type: 'op', text: two, pos: i });
      i += 2;
      continue;
    }
    // `=` is emitted rather than rejected: predicates use it, and they are read
    // back out of the raw source. A bare `=` where a comparison belongs is
    // caught by the parser, which can say so precisely.
    if ('<>().,='.includes(ch)) {
      out.push({ type: 'op', text: ch, pos: i });
      i++;
      continue;
    }
    throw new ExprSyntaxError(`unexpected character \`${ch}\``, src, i);
  }
  return out;
}

/**
 * Everything inside a `rows(t, <here>)` or `.where(<here>)` is kept as raw text
 * and handed to the adapter, which knows how to match it against a row. Keeping
 * predicates out of the expression grammar is what stops this language from
 * slowly turning into SQL.
 */
function rawUntilClose(src: string, tokens: Token[], from: number): { text: string; next: number } {
  let depth = 0;
  let i = from;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type === 'op' && t.text === '(') depth++;
    else if (t.type === 'op' && t.text === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i >= tokens.length) throw new ExprSyntaxError('unclosed predicate', src, tokens[from]?.pos ?? 0);
  const start = tokens[from]!.pos;
  const end = tokens[i]!.pos;
  return { text: src.slice(start, end).trim(), next: i };
}

/**
 * Reads a predicate the moment it is captured, so nothing unparsed reaches a run.
 *
 * The evaluator reads predicates per row, and `Array.prototype.filter` never
 * calls its callback on an empty list — so a predicate over a selection that
 * matched nothing was never read at all, and `count(...) == 0` over it was
 * satisfied by never having done any work. Reading it here makes an
 * unsupported predicate a syntax error at load time, which is where `check`
 * and the scenario loader can see it, and removes the row count from the
 * question entirely.
 */
function validatePredicate(raw: string, source: string, at: number): void {
  try {
    parsePredicate(raw);
  } catch (error) {
    throw new ExprSyntaxError(error instanceof Error ? error.message : String(error), source, at);
  }
}

export function parse(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;
  // Where each column was named, so `requireSides` can point at a side-less
  // one once the whole tree is known.
  const columnAt = new WeakMap<Expr, number>();

  const peek = (): Token | undefined => tokens[pos];
  const at = (text: string): boolean => peek()?.text === text;
  const eat = (text: string): boolean => (at(text) ? (pos++, true) : false);
  const expect = (text: string): Token => {
    const t = peek();
    if (!t || t.text !== text) {
      throw new ExprSyntaxError(`expected \`${text}\``, source, t?.pos ?? source.length);
    }
    pos++;
    return t;
  };

  function parseOr(): Expr {
    let left = parseAnd();
    while (at('or')) {
      pos++;
      left = { node: 'logical', op: 'or', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): Expr {
    let left = parseCompare();
    while (at('and')) {
      pos++;
      left = { node: 'logical', op: 'and', left, right: parseCompare() };
    }
    return left;
  }

  function parseCompare(): Expr {
    const left = parseUnary();
    const t = peek();
    if (t && t.type === 'op' && t.text === '=') {
      throw new ExprSyntaxError('use `==` to compare (a single `=` is only for predicates)', source, t.pos);
    }
    if (t && t.type === 'op' && COMPARE_OPS.has(t.text)) {
      pos++;
      return { node: 'compare', op: t.text as CompareOp, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary(): Expr {
    if (at('not')) {
      pos++;
      return { node: 'not', operand: parseUnary() };
    }
    return parsePostfix();
  }

  function parsePostfix(): Expr {
    let expr = parsePrimary();
    let pendingTemporal: Temporal | null = null;

    while (at('.')) {
      pos++;
      const name = peek();
      if (!name || name.type !== 'ident') {
        throw new ExprSyntaxError('expected a name after `.`', source, name?.pos ?? source.length);
      }
      pos++;

      // Method form: `.where(...)`, `.isEmpty()`.
      if (at('(')) {
        pos++;
        if (name.text === 'where') {
          const raw = rawUntilClose(source, tokens, pos);
          pos = raw.next;
          expect(')');
          validatePredicate(raw.text, source, raw.next);
          expr = { node: 'predicate', source: expr, predicate: raw.text };
          continue;
        }
        if (name.text === 'isEmpty') {
          expect(')');
          expr = { node: 'isEmpty', source: expr };
          continue;
        }
        throw new ExprSyntaxError(`unknown method \`${name.text}\``, source, name.pos);
      }

      // `response.body.id` keeps accumulating into one path. Ahead of the
      // temporal check: a response is JSON, not a row, and has no sides — but
      // `response.body.after` (a pagination cursor, one half of an audit pair)
      // was taken for `.after` and refused as "must be followed by a column".
      if (expr.node === 'response') {
        expr = { node: 'response', path: expr.path ? `${expr.path}.${name.text}` : name.text };
        continue;
      }

      // `.before` / `.after` / `.delta` select which side the next column reads.
      if (TEMPORALS.has(name.text) && pendingTemporal === null) {
        pendingTemporal = name.text as Temporal;
        continue;
      }

      expr = { node: 'column', source: expr, column: name.text, temporal: pendingTemporal };
      columnAt.set(expr, name.pos);
      pendingTemporal = null;
    }

    if (pendingTemporal !== null) {
      throw new ExprSyntaxError(
        `\`.${pendingTemporal}\` must be followed by a column name`,
        source,
        source.length,
      );
    }
    return expr;
  }

  function parsePrimary(): Expr {
    const t = peek();
    if (!t) throw new ExprSyntaxError('unexpected end of expression', source, source.length);

    if (t.type === 'var') {
      pos++;
      return { node: 'variable', name: t.text };
    }
    if (t.type === 'string') {
      pos++;
      return { node: 'literal', value: t.text };
    }
    if (t.type === 'number') {
      pos++;
      return { node: 'literal', value: t.text.includes('.') ? t.text : Number(t.text) };
    }
    if (t.type === 'op' && t.text === '(') {
      pos++;
      const inner = parseOr();
      expect(')');
      return inner;
    }
    if (t.type !== 'ident') {
      throw new ExprSyntaxError(`unexpected \`${t.text}\``, source, t.pos);
    }
    pos++;

    if (t.text === 'true') return { node: 'literal', value: true };
    if (t.text === 'false') return { node: 'literal', value: false };
    if (t.text === 'null') return { node: 'literal', value: null };
    if (t.text === 'response') return { node: 'response', path: '' };

    if (at('(')) {
      pos++;
      return parseCall(t);
    }

    // A bare table name observes every change to that table.
    return { node: 'select', selector: { kind: 'changes', table: t.text } };
  }

  function parseCall(name: Token): Expr {
    if (SELECTOR_KINDS.has(name.text)) {
      const selector: Selector = { kind: name.text as SelectorKind };
      // `rows()` is `rows(*)` without the star and fails for the same reason:
      // no table, so the engine's pre-fetch skips it and every run refuses it.
      // It loaded and `check` passed it clean (measured: `count(rows()) == 0`,
      // exit 0) while `rows(*)` one character away was refused here. The other
      // kinds stay: with no table they mean every table, as `changes(*)` does,
      // and the evaluator answers them.
      if (name.text === 'rows' && at(')')) {
        throw new ExprSyntaxError(
          '`rows()` cannot be read — `rows` needs one table to select from. ' +
            'Use `changes(*)` to ask about every table this run wrote to.',
          source,
          peek()!.pos,
        );
      }
      if (!at(')')) {
        const table = peek();
        if (!table || table.type !== 'ident') {
          throw new ExprSyntaxError('expected a table name', source, table?.pos ?? source.length);
        }
        pos++;
        // `rows(*)` parses and can never be answered: the engine's pre-fetch
        // skips any selector with no table, so the lookup map never holds it
        // and the evaluator refuses at run time with "the rows of `*` could not
        // be read". A form that is always undecided is a syntax error, not a
        // capability — the same lesson as `all()`, which parsed, passed
        // `check`, and poisoned every run that used it into exit 3.
        if (name.text === 'rows' && table.text === '*') {
          throw new ExprSyntaxError(
            '`rows(*)` cannot be read — `rows` needs one table to select from. ' +
              'Use `changes(*)` to ask about every table this run wrote to.',
            source,
            table.pos,
          );
        }
        // `changes(*)` means every table in scope.
        if (table.text !== '*') selector.table = table.text;
        // `changes(* except a, b)` — every watched table but these. Only after
        // `*`: `changes(payments except x)` would be asking for the complement
        // of one table, which is the whole schema minus one, spelled
        // misleadingly.
        const after = peek();
        if (after && after.type === 'ident' && after.text.toLowerCase() === 'except') {
          if (table.text !== '*') {
            throw new ExprSyntaxError(
              '`except` needs `*` on its left — it names what to leave out of everything watched',
              source,
              after.pos,
            );
          }
          pos++;
          const excluded: string[] = [];
          for (;;) {
            const name = peek();
            if (!name || name.type !== 'ident') {
              throw new ExprSyntaxError(
                'expected a table name after `except`',
                source,
                name?.pos ?? source.length,
              );
            }
            pos++;
            excluded.push(name.text);
            if (!eat(',')) break;
          }
          selector.exceptTables = excluded;
        }
        if (eat(',')) {
          const raw = rawUntilClose(source, tokens, pos);
          pos = raw.next;
          validatePredicate(raw.text, source, raw.next);
          selector.predicate = raw.text;
        }
      }
      expect(')');
      return { node: 'select', selector };
    }

    if (AGGREGATES.has(name.text)) {
      const inner = parseOr();
      expect(')');
      return { node: 'aggregate', fn: name.text as never, source: inner };
    }

    if (TEMPORALS.has(name.text)) {
      const inner = parseOr();
      expect(')');
      // `delta(x.balance)` resolves the column the wrapper was written for.
      if (inner.node === 'column' && inner.temporal === null) {
        return { ...inner, temporal: name.text as Temporal };
      }
      throw new ExprSyntaxError(
        `\`${name.text}(...)\` takes a column, e.g. ${name.text}(wallets.balance)`,
        source,
        name.pos,
      );
    }

    if (name.text === 'hasWrite') {
      const inner = parseOr();
      expect(')');
      return { node: 'hasWrite', source: inner };
    }
    if (name.text === 'isEmpty') {
      const inner = parseOr();
      expect(')');
      return { node: 'isEmpty', source: inner };
    }
    if (name.text === 'atomic') {
      const inner = parseOr();
      expect(')');
      return { node: 'atomic', source: inner };
    }
    if (name.text === 'writeCount') {
      const inner = parseOr();
      expect(')');
      return { node: 'writeCount', source: inner };
    }

    throw new ExprSyntaxError(`unknown function \`${name.text}\``, source, name.pos);
  }

  /**
   * Refuses a column read with no side — `single(updated(wallets)).balance`.
   *
   * The evaluator refuses every such column it reaches, with this sentence,
   * whatever the run did: no row and no engine makes "the balance" mean before
   * or after. So it is always undecided, and like `rows(*)` it belongs here. It
   * used to load and get `check`'s unconditional clean sentence, and be
   * refused only by a run.
   *
   * On the finished tree, not while building it: `delta(x.balance)`,
   * `before(...)` and `after(...)` parse their column side-less and supply the
   * side on the way out, so a column is side-less only if nothing claimed it by
   * the end. That is the evaluator's own test — `temporal === null` on a column
   * node — and nothing wider: a predicate's columns are raw text and
   * `response.body.x` is a path, and neither is a column node. Anywhere in the
   * tree, including the far side of an `and` or `or`: reached, it is refused,
   * and whether it is reached is decided by the other operand, never by it.
   */
  const requireSides = (node: Expr): void => {
    switch (node.node) {
      case 'column':
        if (node.temporal === null) {
          throw new ExprSyntaxError(needsSide(node.column), source, columnAt.get(node) ?? 0);
        }
        requireSides(node.source);
        return;
      case 'aggregate':
      case 'predicate':
      case 'hasWrite':
      case 'isEmpty':
      case 'atomic':
      case 'writeCount':
        requireSides(node.source);
        return;
      case 'compare':
      case 'logical':
        requireSides(node.left);
        requireSides(node.right);
        return;
      case 'not':
        requireSides(node.operand);
        return;
      case 'literal':
      case 'response':
      case 'variable':
      case 'select':
        return;
    }
  };

  const expr = parseOr();
  if (pos < tokens.length) {
    throw new ExprSyntaxError(`unexpected trailing \`${tokens[pos]!.text}\``, source, tokens[pos]!.pos);
  }
  requireSides(expr);
  return expr;
}

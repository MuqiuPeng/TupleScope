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

import type { Expr, CompareOp, Selector, SelectorKind, Temporal } from '@statescope/core';

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
  'all',
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

export function parse(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;

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

      // `.before` / `.after` / `.delta` select which side the next column reads.
      if (TEMPORALS.has(name.text) && pendingTemporal === null) {
        pendingTemporal = name.text as Temporal;
        continue;
      }

      // `response.body.id` keeps accumulating into one path.
      if (expr.node === 'response') {
        expr = { node: 'response', path: expr.path ? `${expr.path}.${name.text}` : name.text };
        continue;
      }

      expr = { node: 'column', source: expr, column: name.text, temporal: pendingTemporal };
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
      if (!at(')')) {
        const table = peek();
        if (!table || table.type !== 'ident') {
          throw new ExprSyntaxError('expected a table name', source, table?.pos ?? source.length);
        }
        pos++;
        // `changes(*)` means every table in scope.
        if (table.text !== '*') selector.table = table.text;
        if (eat(',')) {
          const raw = rawUntilClose(source, tokens, pos);
          pos = raw.next;
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

    throw new ExprSyntaxError(`unknown function \`${name.text}\``, source, name.pos);
  }

  const expr = parseOr();
  if (pos < tokens.length) {
    throw new ExprSyntaxError(`unexpected trailing \`${tokens[pos]!.text}\``, source, tokens[pos]!.pos);
  }
  return expr;
}

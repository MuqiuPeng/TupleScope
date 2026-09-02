import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse, ExprSyntaxError } from './parse.js';

describe('parse', () => {
  it('reads response paths as one accumulated path', () => {
    assert.deepEqual(parse('response.status'), { node: 'response', path: 'status' });
    assert.deepEqual(parse('response.body.id'), { node: 'response', path: 'body.id' });
    assert.deepEqual(parse('response.headers.location'), {
      node: 'response',
      path: 'headers.location',
    });
  });

  it('treats a bare table name as every change to it', () => {
    assert.deepEqual(parse('payments'), {
      node: 'select',
      selector: { kind: 'changes', table: 'payments' },
    });
  });

  it('reads `changes(*)` as schema-wide, with no table', () => {
    const expr = parse('changes(*)');
    assert.equal(expr.node, 'select');
    assert.equal(expr.node === 'select' ? expr.selector.table : 'set', undefined);
  });

  it('keeps predicates as raw text rather than parsing them as expressions', () => {
    const expr = parse('rows(wallets, id = "wal_alice")');
    assert.deepEqual(expr, {
      node: 'select',
      selector: { kind: 'rows', table: 'wallets', predicate: 'id = "wal_alice"' },
    });
  });

  it('accepts `=` inside a predicate but refuses it as a comparison', () => {
    // The tokenizer must not reject `=` outright: predicates need it.
    assert.doesNotThrow(() => parse('inserted(t).where(type = "REVERSAL")'));
    assert.throws(() => parse('payments.status = 1'), /use `==` to compare/);
  });

  it('resolves the temporal side from a wrapper', () => {
    const expr = parse('delta(wallets.balance)');
    assert.deepEqual(expr, {
      node: 'column',
      source: { node: 'select', selector: { kind: 'changes', table: 'wallets' } },
      column: 'balance',
      temporal: 'delta',
    });
  });

  it('resolves the temporal side from a postfix', () => {
    const expr = parse('single(updated(payments)).after.status');
    assert.equal(expr.node, 'column');
    assert.equal(expr.node === 'column' ? expr.temporal : null, 'after');
    assert.equal(expr.node === 'column' ? expr.column : null, 'status');
  });

  it('leaves a column with no stated side unresolved rather than guessing', () => {
    // "the status" meaning before or after is the whole question, so the parser
    // records the ambiguity and the evaluator refuses it with a useful message.
    const expr = parse('payments.status');
    assert.equal(expr.node === 'column' ? expr.temporal : 'set', null);
  });

  it('refuses a dangling temporal', () => {
    assert.throws(() => parse('single(updated(payments)).after'), /must be followed by a column/);
  });

  it('nests aggregates over columns over selections', () => {
    const expr = parse('sum(delta(wallets.balance))');
    assert.equal(expr.node, 'aggregate');
    assert.equal(expr.node === 'aggregate' ? expr.fn : null, 'sum');
    assert.equal(expr.node === 'aggregate' ? expr.source.node : null, 'column');
  });

  it('parses both call and method forms of isEmpty', () => {
    assert.equal(parse('isEmpty(changes(t))').node, 'isEmpty');
    assert.equal(parse('changes(t).isEmpty()').node, 'isEmpty');
  });

  it('reads variables as their own node', () => {
    const expr = parse('response.body.id == {{refund_id}}');
    assert.equal(expr.node, 'compare');
    assert.deepEqual(expr.node === 'compare' ? expr.right : null, {
      node: 'variable',
      name: 'refund_id',
    });
  });

  it('binds `and` tighter than `or`', () => {
    const expr = parse('a.isEmpty() or b.isEmpty() and c.isEmpty()');
    assert.equal(expr.node, 'logical');
    assert.equal(expr.node === 'logical' ? expr.op : null, 'or');
    assert.equal(expr.node === 'logical' ? expr.right.node : null, 'logical');
  });

  it('keeps a decimal literal as text so it stays exact', () => {
    // `100.00` must not become a JS number on the way through the parser.
    const expr = parse('x.after.amount == 100.00');
    assert.deepEqual(expr.node === 'compare' ? expr.right : null, {
      node: 'literal',
      value: '100.00',
    });
  });

  it('reports the offset of a syntax error', () => {
    try {
      parse('count(inserted(t)');
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof ExprSyntaxError);
      assert.match(error.message, /expected/);
    }
  });

  it('rejects unknown functions by name', () => {
    assert.throws(() => parse('frobnicate(payments)'), /unknown function `frobnicate`/);
  });

  it('rejects trailing junk instead of silently ignoring it', () => {
    assert.throws(() => parse('response.status == 200 200'), /trailing/);
  });
});

describe('rows(*)', () => {
  it('is a syntax error, not a run-time refusal', () => {
    // It parsed, and then the engine's pre-fetch skipped it — a selector with
    // no table never enters the lookup map — so every use was undecided at run
    // time. The same shape as `all()`, which parsed, passed `check`, and made
    // the run exit 3 over a form that could never do anything.
    assert.throws(() => parse('count(rows(*)) == 0'), /`rows\(\*\)` cannot be read/);
  });

  it('leaves changes(*) alone, which does mean every table', () => {
    assert.doesNotThrow(() => parse('hasWrite(changes(*)) == false'));
  });

  it('still accepts rows with a table', () => {
    assert.doesNotThrow(() => parse('count(rows(wallets, id = "x")) == 1'));
  });
});

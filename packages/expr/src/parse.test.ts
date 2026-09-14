import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, Expr } from '@tuplescope/core';
import { parse, ExprSyntaxError } from './parse.js';
import { Unevaluable, evaluateAssertion, evaluateExpr } from './evaluate.js';

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

  it('refuses a column with no stated side rather than guessing', () => {
    // "the status" meaning before or after is the whole question. This used to
    // parse, leaving the evaluator to refuse it at run time; see `a column with
    // no side` below for why it is refused here now.
    assert.throws(() => parse('payments.status'), /`status` needs a side/);
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

describe('rows()', () => {
  it('is a syntax error, like rows(*), which lacks the same table', () => {
    // Measured: `count(rows()) == 0` loaded and `check` passed it clean, exit
    // 0, while `rows(*)` — the same missing table, one character away — was
    // refused at load. The engine's pre-fetch skips both, so every run would
    // have left it undecided.
    assert.throws(
      () => parse('count(rows()) == 0'),
      (error: unknown) =>
        error instanceof ExprSyntaxError &&
        error.message.startsWith('`rows()` cannot be read — `rows` needs one table to select from.') &&
        error.position === 11,
    );
  });

  it('leaves the other kinds alone, which with no table mean every table', () => {
    // `changes()` is answered exactly like `changes(*)`; only `rows` needs a table.
    for (const kind of ['changes', 'inserted', 'updated', 'deleted']) {
      assert.doesNotThrow(() => parse(`count(${kind}()) == 0`), kind);
    }
  });
});

describe('a column with no side', () => {
  const SENTENCE =
    '`balance` needs a side: write .before.balance, .after.balance, or delta(...balance).';

  it('is a syntax error at load, not a run-time refusal', () => {
    // Measured: `single(updated(wallets)).balance == "1"` loaded, `check` gave
    // it "Nothing here would fail for a reason other than the system under
    // test", and only a run refused it — with this sentence, whatever the run
    // did. A form that is always undecided is a syntax error.
    assert.throws(
      () => parse('single(updated(wallets)).balance == "1"'),
      (error: unknown) =>
        error instanceof ExprSyntaxError && error.message.startsWith(SENTENCE) && error.position === 25,
    );
  });

  it('is refused with the sentence the evaluator uses', () => {
    // The evaluator still refuses an `Expr` that reaches it without `parse`.
    const expr: Expr = {
      node: 'column',
      source: { node: 'select', selector: { kind: 'updated', table: 'wallets' } },
      column: 'balance',
      temporal: null,
    };
    assert.throws(
      () => evaluateExpr(expr, { changes: {} as ChangeSet, variables: {} }),
      (error: unknown) => error instanceof Unevaluable && error.message === SENTENCE,
    );
  });

  // Every position an expression can hold a column in. The evaluator reads each
  // when it reaches it, and a side-less column it reaches is always refused.
  for (const source of [
    'payments.status == "PAID"', // the bare-table shorthand, read as a value
    '"PAID" == single(updated(payments)).status',
    'not single(updated(payments)).status',
    'count(inserted(t)) == 1 and single(updated(payments)).status == "PAID"',
    // Reached only when the left side is false, so whether the run refuses it
    // is decided by the other operand — never by the column.
    'count(inserted(t)) == 1 or single(updated(payments)).status == "PAID"',
    'sum(wallets.balance) == "0"',
    'max(updated(wallets).balance) == "0"',
    'count(single(updated(payments)).status.where(id = "x")) == 0',
    'hasWrite(payments.status) == false',
    'isEmpty(payments.status) == true',
    'atomic(payments.status) == true',
    'writeCount(payments.status) == 1',
    'payments.status.after.id == "x"', // side-less underneath a sided read
    'delta(payments.status.amount) == "0"', // side-less underneath a wrapper's column
    '{{row}}.status == "PAID"',
  ]) {
    it(`refuses \`${source}\``, () => {
      assert.throws(
        () => parse(source),
        (error: unknown) =>
          error instanceof ExprSyntaxError && / needs a side: write \.before\./.test(error.message),
      );
    });
  }

  // Every place a column is legal without a side of its own: a wrapper or a
  // postfix supplies it before the evaluator reaches the column. evaluate.test
  // proves each of these is also *decided*.
  for (const [source, temporal] of [
    ['delta(single(updated(wallets, id = "w")).balance) == "250.00"', 'delta'],
    ['sum(delta(wallets.balance)) == "0"', 'delta'], // bare-table shorthand; what `promote` emits
    ['after(single(rows(wallets, id = "w")).balance) == "1"', 'after'],
    ['before(single(updated(wallets)).balance) == "1"', 'before'],
    ['after(updated(wallets, id = "w").balance)', 'after'], // a panel source: no single()
    ['max(after(updated(wallets).balance)) == "1"', 'after'],
    ['single(updated(payments)).before.status == "PAID"', 'before'],
    ['single(updated(payments)).after.status == "PAID"', 'after'],
    ['single(updated(payments)).delta.amount == "1"', 'delta'],
    ['sum(wallets.after.balance) == "1"', 'after'],
    ['"PAID" == single(updated(payments)).after.status', 'after'],
  ] as const) {
    it(`accepts \`${source}\``, () => {
      assert.equal(firstColumn(parse(source))?.temporal, temporal);
    });
  }

  it('leaves reads that are not columns alone', () => {
    // A predicate's columns are raw text and a response path is a path; neither
    // is a column node, and neither has a side to state.
    for (const source of [
      'response.body.balance == "1"',
      'count(inserted(t).where(balance = "1")) == 0',
      'count(rows(wallets, balance = "1")) == 0',
      'inserted(t).isEmpty()',
    ]) {
      assert.doesNotThrow(() => parse(source), source);
    }
  });
});

describe('a response path', () => {
  it('reads before, after and delta as field names, not sides', () => {
    // A response is JSON and has no sides. `response.body.after` — a pagination
    // cursor, one half of an audit pair — was refused as "`.after` must be
    // followed by a column name".
    assert.deepEqual(parse('response.body.after'), { node: 'response', path: 'body.after' });
    assert.deepEqual(parse('response.body.page.before.id'), {
      node: 'response',
      path: 'body.page.before.id',
    });
    assert.deepEqual(parse('response.body.delta'), { node: 'response', path: 'body.delta' });
    const { passed } = evaluateAssertion(parse('response.body.after == "c2"'), {
      changes: {} as ChangeSet,
      variables: {},
      response: { status: 200, headers: {}, body: { after: 'c2' } },
    });
    assert.equal(passed, true);
  });
});

/** The outermost, leftmost column an expression reads. */
function firstColumn(expr: Expr): Extract<Expr, { node: 'column' }> | undefined {
  switch (expr.node) {
    case 'column':
      return expr;
    case 'compare':
    case 'logical':
      return firstColumn(expr.left) ?? firstColumn(expr.right);
    case 'not':
      return firstColumn(expr.operand);
    case 'literal':
    case 'response':
    case 'variable':
    case 'select':
      return undefined;
    default:
      return firstColumn(expr.source);
  }
}

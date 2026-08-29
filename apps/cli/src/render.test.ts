/**
 * The rendering is the product. These tests are mostly about the two ways it
 * can lie: hiding something without saying so, and depending on colour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, RowChange, Value } from '@tuplescope/core';
import { visible } from '@tuplescope/core';
import {
  jsonLeaves,
  renderDiff,
  renderKey,
  renderValue,
  renderWriteOrder,
  widthOf,
  type Style,
} from './render.js';

const style: Style = { color: false, ascii: false, width: 100 };
const v = (text: string | null, pgType = 'text'): Value => visible(pgType, text);

function change(partial: Partial<RowChange> & Pick<RowChange, 'table' | 'kind'>): RowChange {
  return {
    key: null,
    before: null,
    after: null,
    changedColumns: [],
    visibleColumns: [],
    hasWrite: true,
    ...partial,
  };
}

function keyed(column: string, value: string): RowChange['key'] {
  return { columns: [{ column, value: v(value) }], token: `${column}=${value}` };
}

const set = (changes: RowChange[]): ChangeSet => ({
  captureMethod: 'mvcc-xmin',
  detection: 'write',
  fidelity: 'net',
  scope: { schema: 'public', database: 'test', allTables: true, tables: [] },
  changes,
  // Required, so a ChangeSet cannot exist without saying how its text was printed.
  rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
  warnings: [],
  durationMs: 1,
});

const options = {
  style,
  columns: 4 as const,
  maxRows: 3,
  maxTables: 6,
  interesting: new Set<string>(),
  indent: '',
};

describe('the diff grid', () => {
  it('prints the table name once and aligns every row under it', () => {
    const lines = renderDiff(
      set([
        change({
          table: 'wallets',
          kind: 'update',
          key: keyed('id', 'wal_alice'),
          before: { balance: v('900.00', 'numeric') },
          after: { balance: v('1000.00', 'numeric') },
          changedColumns: ['balance'],
          visibleColumns: ['balance'],
        }),
        change({
          table: 'wallets',
          kind: 'update',
          key: keyed('id', 'wal_bookshop'),
          before: { balance: v('100.00', 'numeric') },
          after: { balance: v('0.00', 'numeric') },
          changedColumns: ['balance'],
          visibleColumns: ['balance'],
        }),
      ]),
      options,
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^wallets/);
    // The second row carries no table name, and its value column starts where
    // the first one's did — a fixed key width used to break exactly this.
    assert.doesNotMatch(lines[1]!, /wallets/);
    assert.equal(lines[0]!.indexOf('balance'), lines[1]!.indexOf('balance'));
  });

  it('right-aligns both sides of a transition so money reads as money', () => {
    const lines = renderDiff(
      set([
        change({
          table: 'w',
          kind: 'update',
          key: keyed('id', 'a'),
          before: { balance: v('900.00', 'numeric') },
          after: { balance: v('1000.00', 'numeric') },
          changedColumns: ['balance'],
          visibleColumns: ['balance'],
        }),
      ]),
      options,
    );
    assert.match(lines[0]!, / 900\.00 → 1000\.00/);
  });

  it('names the write that changed nothing, and why it is invisible', () => {
    // The product's whole differentiator. A blank line here would read as
    // "nothing happened", which is the opposite of the truth.
    const lines = renderDiff(
      set([
        change({
          table: 'refunds',
          kind: 'update',
          key: keyed('id', 'rf_1'),
          before: { id: v('rf_1'), updated_at: v('t0') },
          after: { id: v('rf_1'), updated_at: v('t1') },
          changedColumns: ['updated_at'],
          visibleColumns: [],
        }),
      ]),
      options,
    );
    assert.match(lines[0]!, /written, no visible change/);
    assert.match(lines[1]!, /only updated_at changed, which is ignored/);
  });

  it('caps rows and says how many it hid, and which flag shows them', () => {
    // Silent truncation in a tool whose claim is "exactly what changed" would
    // be the worst possible failure.
    const many = Array.from({ length: 10 }, (_, i) =>
      change({
        table: 't',
        kind: 'insert',
        key: keyed('id', String(i)),
        after: { id: v(String(i)) },
      }),
    );
    const lines = renderDiff(set(many), options);
    const note = lines.find((l) => l.includes('more rows'));
    assert.ok(note, 'the cap must be announced');
    assert.match(note!, /\(\+7 more rows · --diff all\)/);
  });

  it('caps columns on an insert and says the same', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`col_${String(i).padStart(2, '0')}`, v(`v${i}`)]),
    );
    const lines = renderDiff(
      set([change({ table: 't', kind: 'insert', key: keyed('col_00', 'v0'), after: wide })]),
      options,
    );
    assert.ok(lines.some((l) => /\(\+8 more columns · --columns all\)/.test(l)));
    assert.equal(lines.filter((l) => /col_\d\d\s/.test(l)).length, 4);
  });

  it('ranks a column named in an assertion above the rest', () => {
    // The reader is looking at this diff *because* of that assertion.
    const lines = renderDiff(
      set([
        change({
          table: 't',
          kind: 'insert',
          key: keyed('id', '1'),
          after: { id: v('1'), aaa: v('x'), zzz_status: v('SENT') },
        }),
      ]),
      { ...options, columns: 1, interesting: new Set(['zzz_status']) },
    );
    assert.match(lines[0]!, /zzz_status/);
  });

  it('shows an unkeyed row without collapsing the grid', () => {
    // Exactly the tables that already carry degraded-row-identity.
    const lines = renderDiff(
      set([change({ table: 'audit', kind: 'insert', key: null, after: { note: v('hi') } })]),
      options,
    );
    assert.match(lines[0]!, /\(unkeyed\)/);
    assert.match(lines[0]!, /note/);
  });
});

describe('values', () => {
  it('renders NULL as a word, not an empty cell', () => {
    assert.equal(renderValue(style, v(null), 20), 'NULL');
    assert.equal(renderValue(style, undefined, 20), 'NULL');
  });

  it('collapses newlines so one value cannot break the grid', () => {
    assert.equal(renderValue(style, v('a\nb'), 20), 'a⏎b');
    assert.equal(renderValue({ ...style, ascii: true }, v('a\nb'), 20), 'a\\nb');
  });

  it('marks a long value with its real size', () => {
    const rendered = renderValue(style, v('x'.repeat(500)), 40);
    assert.match(rendered, /…⟨500B⟩$/);
    assert.ok(widthOf(rendered) < 60);
  });

  it('middle-ellipsises a long key, keeping both ends', () => {
    const long = renderKey(
      change({ table: 't', kind: 'insert', key: keyed('id', 'pay_01hq7z8njv8') }),
      style,
    );
    assert.ok(long.length <= 14 + 1);
    assert.match(long, /^pay_01hq…/);
  });
});

describe('jsonb', () => {
  it('reports the leaf that moved, not the whole document', () => {
    const leaves = jsonLeaves(
      { attempts: 0, lastError: 'timeout', headers: { a: '1' } },
      { attempts: 1, headers: { a: '1', retry: '1' } },
    );
    const paths = leaves.map((l) => l.path).sort();
    assert.deepEqual(paths, ['.attempts', '.headers.retry', '.lastError']);
  });

  it('distinguishes added, removed and changed', () => {
    const byPath = new Map(jsonLeaves({ a: 1, b: 2 }, { a: 9, c: 3 }).map((l) => [l.path, l]));
    assert.deepEqual(
      [byPath.get('.a')!.before, byPath.get('.a')!.after],
      [1, 9],
      'changed carries both sides',
    );
    assert.equal(byPath.get('.b')!.after, undefined, 'removed has no after');
    assert.equal(byPath.get('.c')!.before, undefined, 'added has no before');
  });

  it('indexes into arrays', () => {
    assert.deepEqual(
      jsonLeaves({ items: [{ qty: 1 }, { qty: 2 }] }, { items: [{ qty: 1 }, { qty: 5 }] }).map((l) => l.path),
      ['.items[1].qty'],
    );
  });

  it('says nothing when the documents match, whatever the key order', () => {
    // Postgres reorders object keys; the engine already knows these are equal.
    assert.deepEqual(jsonLeaves({ b: 2, a: 1 }, { a: 1, b: 2 }), []);
  });
});

describe('colour', () => {
  it('carries every distinction in words too', () => {
    // The output has to survive NO_COLOR, a screenshot and colour-blindness.
    const plain = renderDiff(
      set([
        change({
          table: 'refunds',
          kind: 'update',
          key: keyed('id', 'r1'),
          before: { id: v('r1'), updated_at: v('t0') },
          after: { id: v('r1'), updated_at: v('t1') },
          changedColumns: ['updated_at'],
          visibleColumns: [],
        }),
      ]),
      options,
    ).join('\n');
    const coloured = renderDiff(
      set([
        change({
          table: 'refunds',
          kind: 'update',
          key: keyed('id', 'r1'),
          before: { id: v('r1'), updated_at: v('t0') },
          after: { id: v('r1'), updated_at: v('t1') },
          changedColumns: ['updated_at'],
          visibleColumns: [],
        }),
      ]),
      { ...options, style: { ...style, color: true } },
    ).join('\n');
    // eslint-disable-next-line no-control-regex
    assert.equal(coloured.replace(/\[[0-9;]*m/g, ''), plain);
  });

  it('measures width without counting escape sequences', () => {
    assert.equal(widthOf('[32mok[0m'), 2);
  });
});

describe('the write order', () => {
  const mutation = (
    sequence: number,
    table: string,
    operation: 'insert' | 'update' | 'delete',
    id: string | null,
    transactionId: string | null = '900',
  ) => ({
    sequence,
    transactionId,
    table,
    operation,
    key: id === null ? null : { columns: [{ column: 'id', value: v(id) }], token: `["${id}"]` },
  });

  const withOrder = (changes: RowChange[], mutations: ReturnType<typeof mutation>[]): ChangeSet => ({
    ...set(changes),
    captureMethod: 'wal',
    fidelity: 'transactional',
    mutations,
  });

  const changed = (table: string, id: string): RowChange =>
    change({
      table,
      kind: 'update',
      key: { columns: [{ column: 'id', value: v(id) }], token: `["${id}"]` },
    });

  const opts = { style, indent: '', maxRows: 8 };

  it('says nothing at all when the engine did not record an order', () => {
    // Not a missing feature — the honest output for an engine that does not
    // know. Inventing a sequence would be worse than silence.
    assert.deepEqual(renderDiff(set([changed('t', 'a')]), options).length > 0, true);
    assert.deepEqual(renderWriteOrder(set([changed('t', 'a')]), opts), []);
  });

  it('reports one clean transaction in a single line', () => {
    // Worth saying: "these were atomic" is not visible anywhere else.
    const lines = renderWriteOrder(
      withOrder(
        [changed('payments', 'p1'), changed('wallets', 'w1')],
        [mutation(0, 'payments', 'update', 'p1'), mutation(1, 'wallets', 'update', 'w1')],
      ),
      opts,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /2 writes, one transaction/);
  });

  it('expands and names the reason when the step was not atomic', () => {
    const lines = renderWriteOrder(
      withOrder(
        [changed('payments', 'p1'), changed('wallets', 'w1')],
        [
          mutation(0, 'payments', 'update', 'p1', '900'),
          mutation(1, 'wallets', 'update', 'w1', '901'),
        ],
      ),
      opts,
    );
    assert.match(lines[0]!, /2 transactions/);
    assert.match(lines[1]!, /payments\s+update/);
    assert.match(lines[1]!, /txn 1/);
    assert.match(lines[2]!, /txn 2/);
  });

  it('shows a row written twice, which the diff above shows once', () => {
    const lines = renderWriteOrder(
      withOrder(
        [changed('wallets', 'w1')],
        [mutation(0, 'wallets', 'update', 'w1'), mutation(1, 'wallets', 'update', 'w1')],
      ),
      opts,
    );
    assert.match(lines[0]!, /a row written more than once/);
    assert.equal(lines.length, 3);
  });

  it('marks a row that never reached the diff', () => {
    // Inserted and deleted inside one transaction: not a net change, so it is
    // correctly absent above, and this is the only place it can be seen.
    const lines = renderWriteOrder(
      withOrder(
        [],
        [mutation(0, 'entries', 'insert', 'ghost'), mutation(1, 'entries', 'delete', 'ghost')],
      ),
      opts,
    );
    assert.match(lines[0]!, /2 written then removed/);
    assert.match(lines[1]!, /not in the diff above/);
  });

  it('caps the list and says how many it hid', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      mutation(i, 't', 'insert', `r${i}`, i < 10 ? '900' : '901'),
    );
    const lines = renderWriteOrder(withOrder([], many), opts);
    assert.ok(lines.some((l) => /\(\+12 more · --diff all\)/.test(l)));
  });

  it('carries every distinction without colour', () => {
    const built = withOrder(
      [changed('wallets', 'w1')],
      [mutation(0, 'wallets', 'update', 'w1', '900'), mutation(1, 'wallets', 'update', 'w1', '901')],
    );
    const plain = renderWriteOrder(built, opts).join('\n');
    const coloured = renderWriteOrder(built, { ...opts, style: { ...style, color: true } }).join('\n');
    // eslint-disable-next-line no-control-regex
    assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ''), plain);
  });
});

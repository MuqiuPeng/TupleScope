/**
 * The rendering is the product. These tests are mostly about the two ways it
 * can lie: hiding something without saying so, and depending on colour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, RowChange, Value } from '@statescope/core';
import { jsonLeaves, renderDiff, renderKey, renderValue, widthOf, type Style } from './render.js';

const style: Style = { color: false, ascii: false, width: 100 };
const v = (text: string | null, pgType = 'text'): Value => ({ pgType, text });

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
  return { columns: [{ column, value: v(value) }], serialized: `${column}=${value}` };
}

const set = (changes: RowChange[]): ChangeSet => ({
  captureMethod: 'mvcc-xmin',
  detection: 'write',
  scope: { allTables: true, tables: [] },
  changes,
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

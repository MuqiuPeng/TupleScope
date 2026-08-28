/**
 * Every input here was captured from a real PostgreSQL 17.5 running
 * `test_decoding`, copied verbatim. Inventing the format and then testing
 * against the invention is how a parser passes its own tests and fails on the
 * first real row.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeStream, toWireText, UNCHANGED_TOAST } from './decode.js';
import { slotFailure, withinWindow } from './wal-adapter.js';

/** The decoded text of one column, or undefined when the decoder omitted it. */
const text = (m: { columns: ReadonlyMap<string, { text: string | null }> }, column: string) =>
  m.columns.get(column)?.text;

const at = (xid: string, data: string) => ({ xid, data });

describe('decoding a change stream', () => {
  it('reads an insert and its key', () => {
    const { mutations, problems } = decodeStream([
      at('781', 'BEGIN 781'),
      at(
        '781',
        `table public.t: INSERT: id[text]:'r1' n[numeric]:9007199254740993.0000000001 amount[numeric]:100.00 flag[boolean]:true`,
      ),
      at('781', 'COMMIT 781'),
    ]);
    assert.deepEqual(problems, []);
    assert.equal(mutations.length, 1);
    const m = mutations[0]!;
    assert.equal(m.schema, 'public');
    assert.equal(m.table, 't');
    assert.equal(m.operation, 'insert');
    assert.equal(m.transactionId, '781');
    assert.equal(text(m, 'id'), 'r1');
    assert.equal(text(m, 'flag'), 'true');
  });

  it('keeps a delete that carries only its key', () => {
    // What REPLICA IDENTITY DEFAULT actually gives: no other column at all,
    // which is the measured reason before-images come from a snapshot instead.
    const { mutations } = decodeStream([
      at('787', 'BEGIN 787'),
      at('787', `table public.t: DELETE: id[text]:'r1'`),
      at('787', 'COMMIT 787'),
    ]);
    assert.equal(mutations[0]!.operation, 'delete');
    assert.deepEqual([...mutations[0]!.columns.keys()], ['id']);
    assert.equal(text(mutations[0]!, 'id'), 'r1');
  });

  it('marks an untouched TOAST column as the sentinel it is', () => {
    // A parser that took this for a value would write the literal string
    // `unchanged-toast-datum` into the row and report a change that never was.
    const { mutations } = decodeStream([
      at('9', `table public.fid: UPDATE: id[integer]:1 b[boolean]:false toasty[text]:unchanged-toast-datum`),
    ]);
    assert.equal(text(mutations[0]!, 'toasty'), UNCHANGED_TOAST);
  });

  it('keeps a value containing quotes, backslashes and a newline in one piece', () => {
    const { mutations, problems } = decodeStream([
      at('1', `table public.t: INSERT: id[text]:'r1' txt[text]:'has ''q'' and \\ and\nnewline' n[int4]:5`),
    ]);
    assert.deepEqual(problems, []);
    assert.equal(text(mutations[0]!, 'txt'), "has 'q' and \\ and\nnewline");
    // The value swallowed neither the column after it nor the line ending.
    assert.equal(text(mutations[0]!, 'n'), '5');
  });

  it('tells a SQL NULL from the string "null"', () => {
    const { mutations } = decodeStream([
      at('1', `table public.t: INSERT: a[text]:null b[text]:'null'`),
    ]);
    assert.equal(text(mutations[0]!, 'a'), null);
    assert.equal(text(mutations[0]!, 'b'), 'null');
  });

  it('reads an empty string', () => {
    const { mutations } = decodeStream([at('1', `table public.t: INSERT: e[text]:'' id[int4]:1`)]);
    assert.equal(text(mutations[0]!, 'e'), '');
    assert.equal(text(mutations[0]!, 'id'), '1');
  });

  it('keeps two updates to one row as two mutations, in order', () => {
    // The whole point of transactional fidelity: mvcc-xmin sees one changed
    // row here and cannot know it was written twice.
    const { mutations } = decodeStream([
      at('784', 'BEGIN 784'),
      at('784', `table public.t: UPDATE: id[text]:'r1' amount[numeric]:1.00`),
      at('784', `table public.t: UPDATE: id[text]:'r1' amount[numeric]:80.00`),
      at('784', 'COMMIT 784'),
    ]);
    assert.equal(mutations.length, 2);
    assert.deepEqual(
      mutations.map((m) => [m.sequence, text(m, 'amount')]),
      [
        [0, '1.00'],
        [1, '80.00'],
      ],
    );
  });

  it('keeps a row inserted and deleted inside one transaction', () => {
    // Invisible to mvcc-xmin: no row version survives for it to find.
    const { mutations, transactions } = decodeStream([
      at('785', 'BEGIN 785'),
      at('785', `table public.t: INSERT: id[text]:'ghost' amount[numeric]:5.00`),
      at('785', `table public.t: DELETE: id[text]:'ghost'`),
      at('785', 'COMMIT 785'),
    ]);
    assert.deepEqual(
      mutations.map((m) => m.operation),
      ['insert', 'delete'],
    );
    assert.deepEqual(transactions, ['785']);
  });

  it('groups by transaction so atomicity is visible', () => {
    const { mutations, transactions } = decodeStream([
      at('10', 'BEGIN 10'),
      at('10', `table public.a: INSERT: id[int4]:1`),
      at('10', `table public.b: INSERT: id[int4]:1`),
      at('10', 'COMMIT 10'),
      at('11', 'BEGIN 11'),
      at('11', `table public.c: INSERT: id[int4]:1`),
      at('11', 'COMMIT 11'),
    ]);
    assert.deepEqual(transactions, ['10', '11']);
    assert.deepEqual(
      mutations.map((m) => `${m.table}@${m.transactionId}`),
      ['a@10', 'b@10', 'c@11'],
    );
  });

  it('unquotes an identifier that needed quoting', () => {
    const { mutations, problems } = decodeStream([
      at('1', `table public."Order Line": INSERT: "total amount"[numeric]:1.00`),
    ]);
    assert.deepEqual(problems, []);
    assert.equal(mutations[0]!.table, 'Order Line');
    assert.equal(mutations[0]!.columns.get('total amount')?.text, '1.00');
  });

  it('keeps the old key separate from the new tuple', () => {
    // Merging them loses the old key, and worse: an `unchanged-toast-datum` in
    // the new tuple overwrites a perfectly good old value with a sentinel.
    const { mutations, problems } = decodeStream([
      at('1', `table public.t: UPDATE: old-key: id[text]:'a' new-tuple: id[text]:'b' v[int4]:2`),
    ]);
    assert.deepEqual(problems, []);
    assert.equal(text(mutations[0]!, 'id'), 'b', 'the new tuple is where the row is now');
    assert.equal(mutations[0]!.oldKey?.get('id')?.text, 'a', 'and the old key survives');
    assert.equal(text(mutations[0]!, 'v'), '2');
  });

  it('names every table a TRUNCATE hit', () => {
    // One line, several tables. Read with the single-table pattern this became
    // a table called `ta, public.tb` — so both real tables vanished silently.
    const { mutations, problems } = decodeStream([
      at('9', 'BEGIN 9'),
      at('9', 'table public.ta, public.tb: TRUNCATE: (no-flags)'),
      at('9', 'COMMIT 9'),
    ]);
    assert.deepEqual(problems, []);
    assert.deepEqual(
      mutations.map((m) => `${m.schema}.${m.table}:${m.operation}`),
      ['public.ta:truncate', 'public.tb:truncate'],
    );
  });

  it('reports a line it cannot read instead of dropping it silently', () => {
    // An unreadable line means the observation is incomplete, and the engine
    // has to be able to say so rather than report a quieter database.
    const { mutations, problems } = decodeStream([at('1', 'something entirely unexpected')]);
    assert.deepEqual(mutations, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /unrecognised/);
  });

  it('ignores BEGIN, COMMIT and logical messages', () => {
    const { mutations } = decodeStream([
      at('1', 'BEGIN 1'),
      at('1', 'message: transactional: 1 prefix: x, sz: 3 content:abc'),
      at('1', 'COMMIT 1'),
    ]);
    assert.deepEqual(mutations, []);
  });
});

describe('decoded text against what a SELECT returns', () => {
  const bare = (t: string) => ({ text: t, quoted: false });
  const quoted = (t: string) => ({ text: t, quoted: true });

  it('rewrites the three types that disagree', () => {
    // Measured on PostgreSQL 17.5: exactly these three of twenty-seven
    // key-eligible types print in literal syntax rather than output syntax.
    assert.equal(toWireText('bool', bare('true')), 't');
    assert.equal(toWireText('bool', bare('false')), 'f');
    assert.equal(toWireText('bit', bare("B'10101010'")), '10101010');
    assert.equal(toWireText('varbit', bare("B'1010'")), '1010');
  });

  it('leaves the rest exactly as printed', () => {
    for (const [type, value] of [
      ['int4', '42'],
      ['numeric', '123.4500'],
      ['text', 'hi'],
      ['uuid', '00000000-0000-0000-0000-000000000001'],
      ['timestamptz', '2026-01-02 04:04:05+11'],
      ['bytea', '\\x00ff'],
      ['money', '$12.34'],
      ['int4range', '[1,5)'],
    ] as const) {
      assert.equal(toWireText(type, quoted(value)), value, type);
    }
  });

  it('refuses an unchanged TOAST datum rather than comparing it', () => {
    // A sentinel, not a value. Taking it for one produces a key that matches no
    // row, which drops the write out of every question asked about it.
    assert.equal(toWireText('text', bare(UNCHANGED_TOAST)), undefined);
    // ...but a row whose value genuinely is that string was quoted, and is fine.
    assert.equal(toWireText('text', quoted(UNCHANGED_TOAST)), UNCHANGED_TOAST);
  });

  it('passes NULL through as NULL', () => {
    assert.equal(toWireText('bool', { text: null, quoted: false }), null);
  });
});

describe('fencing the window by commit', () => {
  const row = (lsn: string, xid: string, data: string) => ({ lsn, xid, data });

  it('keeps a transaction whole rather than splitting it at the fence', () => {
    // `lsn` is per record, not per transaction — measured, two inserts in one
    // transaction carry different LSNs. Filtering records one by one would
    // admit half a transaction, which is not a state the database was ever in.
    const kept = withinWindow(
      [
        row('0/100', '7', 'BEGIN 7'),
        row('0/100', '7', `table public.t: INSERT: id[int4]:1`),
        row('0/200', '7', `table public.t: INSERT: id[int4]:2`),
        row('0/300', '7', 'COMMIT 7'),
      ],
      '0/150',
    );
    assert.equal(kept.length, 4, 'the whole transaction is in: it committed after the fence');
  });

  it('drops a transaction that committed before the window opened', () => {
    // The slot is created a moment before the snapshot is frozen, so the log
    // sees a little more than the observer does. This is the trim.
    const kept = withinWindow(
      [
        row('0/100', '7', 'BEGIN 7'),
        row('0/110', '7', `table public.t: INSERT: id[int4]:1`),
        row('0/120', '7', 'COMMIT 7'),
        row('0/200', '8', 'BEGIN 8'),
        row('0/210', '8', `table public.t: INSERT: id[int4]:2`),
        row('0/220', '8', 'COMMIT 8'),
      ],
      '0/150',
    );
    assert.deepEqual(
      kept.map((r) => r.xid),
      ['8', '8', '8'],
    );
  });

  it('compares LSNs as numbers, not as strings', () => {
    // `0/9` sorts after `0/10` alphabetically and before it numerically.
    const kept = withinWindow(
      [row('0/9', '7', 'BEGIN 7'), row('0/9', '7', 'COMMIT 7')],
      '0/10',
    );
    assert.deepEqual(kept, [], '0/9 is before 0/10');
    assert.equal(withinWindow([row('0/A', '8', 'COMMIT 8')], '0/9').length, 1, '0/A is after 0/9');
  });

  it('keeps a transaction with no COMMIT rather than dropping it silently', () => {
    // `upto_lsn` is documented not to stop mid-transaction, so this should not
    // happen — and if it does, a visible spurious mutation beats a vanished one.
    const kept = withinWindow([row('0/100', '7', `table public.t: INSERT: id[int4]:1`)], '0/999');
    assert.equal(kept.length, 1);
  });
});

describe('what a replication-slot failure tells you', () => {
  const fail = (code: string, message = 'boom') =>
    slotFailure(Object.assign(new Error(message), { code }), 'statescope_abc123_0');

  it('names a transaction pooler when the slot vanishes between statements', () => {
    // The bare message says the slot does not exist, which reads as a bug in
    // this tool. A temporary slot belongs to one backend, so a pooler that
    // moves the second statement elsewhere produces exactly this — and it is
    // intermittent, which is the worst kind of thing to debug without a hint.
    const error = fail('42704', 'replication slot "statescope_abc123_0" does not exist');
    assert.match(error.message, /transaction-mode connection pooler/);
    assert.match(error.message, /PgBouncer|Supavisor/);
    assert.match(error.message, /mvcc-xmin engine, which needs no/);
    // The original is still there for anyone who wants it.
    assert.match(error.message, /does not exist/);
  });

  it('suggests another StateScope when the name is taken', () => {
    // The name is random per capture, so a collision is not chance.
    assert.match(fail('42710').message, /another StateScope is running/);
  });

  it('points at the slot list when the server is out of them', () => {
    assert.match(fail('53400').message, /max_replication_slots/);
    assert.match(fail('53400').message, /pg_replication_slots/);
  });

  it('passes anything else through unchanged', () => {
    // Wrapping an error nobody anticipated in a guess would be worse than the
    // driver's own words.
    const original = Object.assign(new Error('connection terminated'), { code: '08006' });
    assert.equal(slotFailure(original, 'x'), original);
  });
});

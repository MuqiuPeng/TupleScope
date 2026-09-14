import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ChangeSet, Detection, RowChange, Row, Value } from '@tuplescope/core';
import { parse, predicateClauses } from '@tuplescope/expr';
import { promoteCandidates } from './promote.js';
import { addAssertion, removeAssertion, ScenarioSaveError } from './save.js';
import { masked, textIfVisible, visible } from '@tuplescope/core';

const v = (text: string | null, pgType = 'text'): Value => visible(pgType, text);
const money = (text: string): Value => v(text, 'numeric');

function change(partial: Partial<RowChange> & Pick<RowChange, 'table' | 'kind'>): RowChange {
  const before = partial.before ?? null;
  const after = partial.after ?? null;
  const changed = Object.keys(after ?? before ?? {}).filter(
    (c) => (textIfVisible(before?.[c]) ?? null) !== (textIfVisible(after?.[c]) ?? null),
  );
  return {
    key: null,
    before,
    after,
    changedColumns: changed,
    visibleColumns: changed,
    hasWrite: true,
    ...partial,
  };
}

function keyed(table: string, column: string, value: string): RowChange['key'] {
  return {
    columns: [{ column, value: v(value) }],
    token: JSON.stringify([[column, value]]),
  };
}

function changeSet(changes: RowChange[], detection: Detection = 'write'): ChangeSet {
  return {
    captureMethod: detection === 'write' ? 'mvcc-xmin' : 'snapshot-diff',
    detection,
    fidelity: 'net',
    scope: { schema: 'public', database: 'test', allTables: true, tables: [] },
    changes,
    // Required, so a ChangeSet cannot exist without saying how its text was printed.
    rendering: { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' },
    warnings: [],
    durationMs: 1,
  };
}

const row = (values: Record<string, Value>): Row => values;

describe('promoteCandidates', () => {
  it('every candidate it offers actually parses', async () => {
    // A candidate that does not parse is worse than none: the user clicks it,
    // the scenario stops loading, and the feature has broken their file.
    const changes = changeSet([
      change({
        table: 'payments',
        kind: 'update',
        key: keyed('payments', 'id', 'pay_1'),
        before: row({ id: v('pay_1'), status: v('COMPLETED'), amount: money('100.00') }),
        after: row({ id: v('pay_1'), status: v('REFUNDED'), amount: money('90.00') }),
      }),
      change({
        table: 'wallets',
        kind: 'update',
        key: keyed('wallets', 'id', 'wal_a'),
        before: row({ id: v('wal_a'), balance: money('900.00') }),
        after: row({ id: v('wal_a'), balance: money('1000.00') }),
      }),
      change({
        table: 'wallets',
        kind: 'update',
        key: keyed('wallets', 'id', 'wal_b'),
        before: row({ id: v('wal_b'), balance: money('100.00') }),
        after: row({ id: v('wal_b'), balance: money('0.00') }),
      }),
      change({
        table: 'refunds',
        kind: 'insert',
        key: keyed('refunds', 'id', 'ref_1'),
        after: row({ id: v('ref_1'), reason: v('CUSTOMER_REQUEST') }),
      }),
      change({ table: 'audit', kind: 'insert', after: row({ note: v('hi') }) }),
    ]);

    const candidates = promoteCandidates(changes, {}, 200).candidates;
    assert.ok(candidates.length > 5);
    for (const candidate of candidates) {
      assert.doesNotThrow(
        () => parse(candidate.expression.replace(/\{\{\w+\}\}/g, '"x"')),
        `should parse: ${candidate.expression}`,
      );
      assert.ok(candidate.description.length > 0);
    }
  });

  it('substitutes a captured variable instead of baking in a generated id', async () => {
    // The single thing that decides whether this feature is usable: an id
    // literal passes once and fails on every later run.
    const changes = changeSet([
      change({
        table: 'payments',
        kind: 'update',
        key: keyed('payments', 'id', 'pay_ltx3k01'),
        before: row({ id: v('pay_ltx3k01'), status: v('COMPLETED') }),
        after: row({ id: v('pay_ltx3k01'), status: v('REFUNDED') }),
      }),
    ]);
    const candidates = promoteCandidates(changes, { payment_id: 'pay_ltx3k01' }).candidates;
    const statuses = candidates.filter((c) => c.expression.includes('status'));
    assert.ok(statuses.length > 0);
    for (const candidate of statuses) {
      assert.match(candidate.expression, /\{\{payment_id\}\}/);
      assert.doesNotMatch(candidate.expression, /pay_ltx3k01/);
    }
  });

  it('writes a key holding a quote or a backslash so it reads back as the same value', async () => {
    // Escaped by the lexer's own rule — a backslash and the quote, nothing else.
    const id = 'a"b\\c';
    const changes = changeSet([
      change({
        table: 'notes',
        kind: 'update',
        key: keyed('notes', 'id', id),
        before: row({ id: v(id), body: v('x') }),
        after: row({ id: v(id), body: v('y') }),
      }),
    ]);
    const pinned = promoteCandidates(changes, {}).candidates.filter((c) => c.expression.includes('updated(notes, id = '));
    assert.ok(pinned.length > 0);
    for (const candidate of pinned) {
      const predicate = /updated\(notes, (id = "(?:[^"\\]|\\.)*")\)/.exec(candidate.expression)?.[1];
      assert.ok(predicate, candidate.expression);
      assert.equal(predicateClauses(predicate)[0]!.value, id, candidate.expression);
    }
  });

  it('offers nothing it would have to misspell: a key holding a control character', async () => {
    // The language has no escape for a newline — `\n` reads as the letter n —
    // so JSON.stringify's `"a\nb"` made a kept assertion ask about "anb", which
    // matches no row. There is no honest literal to offer, so none is offered.
    const id = 'a\nb';
    const changes = changeSet([
      change({
        table: 'notes',
        kind: 'update',
        key: keyed('notes', 'id', id),
        before: row({ id: v(id), body: v('x') }),
        after: row({ id: v(id), body: v('y') }),
      }),
    ]);
    const candidates = promoteCandidates(changes, {}).candidates;
    assert.equal(
      candidates.some((c) => c.expression.includes('updated(notes, id = ')),
      false,
      candidates.map((c) => c.expression).join('\n'),
    );
  });

  it('does not match against the {{run}} and {{now}} built-ins', async () => {
    // Otherwise a row whose value happens to equal the run suffix would produce
    // `id == {{run}}`, which is nonsense.
    const changes = changeSet([
      change({
        table: 'payments',
        kind: 'update',
        key: keyed('payments', 'id', 'abc123'),
        before: row({ id: v('abc123'), status: v('A') }),
        after: row({ id: v('abc123'), status: v('B') }),
      }),
    ]);
    const candidates = promoteCandidates(changes, { run: 'abc123', now: 'B' }).candidates;
    for (const candidate of candidates) {
      assert.doesNotMatch(candidate.expression, /\{\{(run|now)\}\}/);
    }
  });

  it('prefers a delta over an absolute value for money', async () => {
    // A delta survives a different starting balance; an absolute does not.
    const changes = changeSet([
      change({
        table: 'wallets',
        kind: 'update',
        key: keyed('wallets', 'id', 'wal_a'),
        before: row({ id: v('wal_a'), balance: money('900.00') }),
        after: row({ id: v('wal_a'), balance: money('1000.00') }),
      }),
    ]);
    const candidates = promoteCandidates(changes, {}).candidates;
    const delta = candidates.find((c) => c.expression.startsWith('delta('));
    assert.ok(delta, 'a delta candidate should be offered');
    assert.match(delta!.expression, /== "100\.00"/);
    assert.doesNotThrow(() => parse(delta!.expression));
    // ...and it should come before the absolute-value form.
    assert.ok(candidates.indexOf(delta!) < candidates.findIndex((c) => c.expression.includes('.after.balance')));
  });

  it('offers the cross-row invariant when a table moved in more than one row', async () => {
    const changes = changeSet([
      change({
        table: 'wallets',
        kind: 'update',
        key: keyed('wallets', 'id', 'wal_a'),
        before: row({ id: v('wal_a'), balance: money('900.00') }),
        after: row({ id: v('wal_a'), balance: money('1000.00') }),
      }),
      change({
        table: 'wallets',
        kind: 'update',
        key: keyed('wallets', 'id', 'wal_b'),
        before: row({ id: v('wal_b'), balance: money('100.00') }),
        after: row({ id: v('wal_b'), balance: money('0.00') }),
      }),
    ]);
    const invariant = promoteCandidates(changes, {}).candidates.find((c) => c.expression.startsWith('sum('));
    assert.ok(invariant);
    assert.equal(invariant!.expression, 'sum(delta(wallets.balance)) == "0.00"');
    assert.match(invariant!.description, /books balance/);
  });

  it('skips volatile columns nobody wants to assert on', async () => {
    const changes = changeSet([
      change({
        table: 'sessions',
        kind: 'update',
        key: keyed('sessions', 'id', 's1'),
        before: row({ id: v('s1'), updated_at: v('t0'), last_seen: v('t0') }),
        after: row({ id: v('s1'), updated_at: v('t1'), last_seen: v('t1') }),
      }),
    ]);
    const candidates = promoteCandidates(changes, {}).candidates;
    assert.ok(!candidates.some((c) => /updated_at|last_seen/.test(c.expression)));
    // The write itself is still worth offering — it is the only finding here.
    assert.ok(candidates.some((c) => c.expression.startsWith('hasWrite(')));
  });

  it('counts per table with the real number, not once per row', async () => {
    // Two ledger legs must offer `== 2` once. Offering `== 1` twice is both a
    // duplicate and a lie, and a candidate that fails the moment you keep it is
    // worse than no candidate.
    const changes = changeSet([
      change({ table: 'legs', kind: 'insert', key: keyed('legs', 'id', '1'),
               after: row({ id: v('1'), type: v('REVERSAL') }) }),
      change({ table: 'legs', kind: 'insert', key: keyed('legs', 'id', '2'),
               after: row({ id: v('2'), type: v('REVERSAL') }) }),
    ]);
    const candidates = promoteCandidates(changes, {}).candidates;
    const counts = candidates.filter((c) => c.expression.startsWith('count(inserted(legs))'));
    assert.equal(counts.length, 1);
    assert.equal(counts[0]!.expression, 'count(inserted(legs)) == 2');

    const typed = candidates.filter((c) => c.expression.includes('where(type'));
    assert.equal(typed.length, 1);
    assert.equal(typed[0]!.expression, 'count(inserted(legs).where(type = "REVERSAL")) == 2');
  });

  it('never offers the same expression twice', async () => {
    const changes = changeSet([
      change({ table: 'legs', kind: 'insert', after: row({ note: v('a') }) }),
      change({ table: 'legs', kind: 'insert', after: row({ note: v('a') }) }),
      change({ table: 'legs', kind: 'insert', after: row({ note: v('b') }) }),
    ]);
    const expressions = promoteCandidates(changes, {}).candidates.map((c) => c.expression);
    assert.equal(new Set(expressions).size, expressions.length);
  });

  it('splits a count by the values actually present', async () => {
    const changes = changeSet([
      change({ table: 'legs', kind: 'insert', key: keyed('legs', 'id', '1'),
               after: row({ id: v('1'), type: v('PAYMENT') }) }),
      change({ table: 'legs', kind: 'insert', key: keyed('legs', 'id', '2'),
               after: row({ id: v('2'), type: v('REVERSAL') }) }),
      change({ table: 'legs', kind: 'insert', key: keyed('legs', 'id', '3'),
               after: row({ id: v('3'), type: v('REVERSAL') }) }),
    ]);
    const byType = promoteCandidates(changes, {}).candidates
      .filter((c) => c.expression.includes('where(type'))
      .map((c) => c.expression)
      .sort();
    assert.deepEqual(byType, [
      'count(inserted(legs).where(type = "PAYMENT")) == 1',
      'count(inserted(legs).where(type = "REVERSAL")) == 2',
    ]);
  });

  it('offers the nothing-happened assertion when nothing happened', async () => {
    const candidates = promoteCandidates(changeSet([]), {}, 200).candidates;
    const nothing = candidates.find((c) => c.expression === 'hasWrite(changes(*)) == false');
    assert.ok(nothing);
    assert.equal(nothing!.caveat, undefined);
    assert.match(nothing!.description, /not even a row rewritten/);
  });

  it('caveats that same assertion under value detection', async () => {
    const candidates = promoteCandidates(changeSet([], 'value'), {}, 200).candidates;
    const nothing = candidates.find((c) => c.expression === 'hasWrite(changes(*)) == false');
    assert.equal(nothing!.caveat?.code, 'reduced-fidelity');
    assert.match(nothing!.caveat!.message, /cannot prove a write did not happen/);
  });

  it('always offers the response status first', async () => {
    assert.equal(
      promoteCandidates(changeSet([]), {}, 422).candidates[0]!.expression,
      'response.status == 422',
    );
  });
});

// ─── writing back ─────────────────────────────────────────────────────────────

const FILE = `# A scenario someone wrote by hand.
version: 1
id: refund
title: Refund
ignoreColumns: [alpha, beta]
why: >
  A refund must reverse the money exactly once.
  Asking twice must not move money twice.

datasets:
  - id: happy
    label: A
    steps:
      # The comment below must survive being edited.
      - id: pay
        name: Pay
        request: { method: POST, path: /payments }
        assert:
          - response.status == 201
      - id: refund
        name: Refund
        request: { method: POST, path: /refund }
`;

describe('addAssertion', () => {
  const withFile = async (fn: (path: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'tuplescope-save-'));
    const path = join(dir, 's.yaml');
    await writeFile(path, FILE, 'utf8');
    try {
      await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('changes nothing but the line it adds', async () => {
    // The strongest form of "preserves formatting": diff the before and after
    // line by line and require exactly one added line.
    await withFile(async (file) => {
      const before = (await readFile(file, 'utf8')).split('\n');
      await addAssertion({
        file,
        datasetId: 'happy',
        stepId: 'pay',
        expression: 'count(inserted(payments)) == 1',
      });
      const after = (await readFile(file, 'utf8')).split('\n');
      assert.equal(after.length, before.length + 1);
      const added = after.filter((line) => !before.includes(line));
      assert.deepEqual(added, ['          - count(inserted(payments)) == 1']);
    });
  });

  it('writes an assertion with a placeholder inside a longer literal, as the loader reads it', async () => {
    // Refused as "does not parse" while every placeholder was swapped for
    // `"placeholder"` first — `"PVT-{{x}}"` became `"PVT-"placeholder""`.
    await withFile(async (file) => {
      const result = await addAssertion({
        file,
        datasetId: 'happy',
        stepId: 'pay',
        expression: 'single(inserted(payments)).after.reference == "PVT-{{payment_id}}"',
      });
      assert.equal(result.added, true);
    });
  });

  it('leaves folded scalars and flow collections exactly as written', async () => {
    await withFile(async (file) => {
      const original = await readFile(file, 'utf8');
      await addAssertion({
        file,
        datasetId: 'happy',
        stepId: 'pay',
        expression: 'count(inserted(payments)) == 1',
      });
      const after = await readFile(file, 'utf8');
      // Re-serialising would unfold the `>` block and pad `[a, b]` to `[ a, b ]`.
      assert.ok(after.includes('\nwhy: >'), 'the folded scalar marker should survive');
      assert.ok(after.includes('ignoreColumns: [alpha, beta]'), 'the flow collection should not be re-padded');
      assert.ok(after.includes(original.split('\n').find((l) => l.includes('Asking twice'))!));
    });
  });

  it('appends to an existing list and keeps every comment', async () => {
    await withFile(async (file) => {
      const result = await addAssertion({
        file,
        datasetId: 'happy',
        stepId: 'pay',
        expression: 'count(inserted(payments)) == 1',
      });
      assert.equal(result.added, true);

      const after = await readFile(file, 'utf8');
      // Parse-and-reserialise would have eaten both of these.
      assert.match(after, /# A scenario someone wrote by hand\./);
      assert.match(after, /# The comment below must survive being edited\./);
      assert.match(after, /- count\(inserted\(payments\)\) == 1/);
      assert.match(after, /- response\.status == 201/);
    });
  });

  it('creates the assert list when a step has none', async () => {
    await withFile(async (file) => {
      await addAssertion({
        file,
        datasetId: 'happy',
        stepId: 'refund',
        expression: 'hasWrite(changes(*)) == false',
      });
      const after = await readFile(file, 'utf8');
      assert.match(after, /id: refund[\s\S]*assert:[\s\S]*hasWrite/);
    });
  });

  it('is a no-op on a second click', async () => {
    await withFile(async (file) => {
      const request = {
        file,
        datasetId: 'happy',
        stepId: 'pay',
        expression: 'count(inserted(payments)) == 1',
      };
      assert.equal((await addAssertion(request)).added, true);
      assert.equal((await addAssertion(request)).added, false);
      const after = await readFile(file, 'utf8');
      assert.equal(after.match(/count\(inserted\(payments\)\)/g)?.length, 1);
    });
  });

  it('refuses to write an expression that does not parse', async () => {
    await withFile(async (file) => {
      await assert.rejects(
        addAssertion({ file, datasetId: 'happy', stepId: 'pay', expression: 'status = 1' }),
        (error: unknown) => {
          assert.ok(error instanceof ScenarioSaveError);
          assert.match(error.message, /does not parse/);
          return true;
        },
      );
      // The file must be untouched, not half-written.
      assert.equal(await readFile(file, 'utf8'), FILE);
    });
  });

  it('names a dataset or step it cannot find', async () => {
    await withFile(async (file) => {
      await assert.rejects(
        addAssertion({ file, datasetId: 'nope', stepId: 'pay', expression: 'response.status == 1' }),
        /has no dataset `nope`/,
      );
      await assert.rejects(
        addAssertion({ file, datasetId: 'happy', stepId: 'nope', expression: 'response.status == 1' }),
        /has no step `nope`/,
      );
    });
  });

  it('removes an assertion, dropping an empty list with it', async () => {
    await withFile(async (file) => {
      const request = {
        file,
        datasetId: 'happy',
        stepId: 'pay',
        expression: 'response.status == 201',
      };
      const result = await removeAssertion(request);
      assert.equal(result.removed, true);
      const after = await readFile(file, 'utf8');
      assert.doesNotMatch(after, /response\.status == 201/);
      assert.doesNotMatch(after, /assert:\s*\n\s*- id: refund/);
      assert.match(after, /# A scenario someone wrote by hand\./);
    });
  });
});

describe('a masked column', () => {
  const maskedValue = (pgType = 'text'): Value => masked(pgType);

  it('never becomes an assertion literal', () => {
    // Demonstrated before this guard: a table whose `status` column is masked
    // produced `count(inserted(cases).where(status = "••••••••")) == 1` — an
    // assertion the reader is offered, `keep` writes into the scenario file,
    // and which passes forever while establishing nothing.
    //
    // Nothing in promote.ts knew about masking; it was safe only by accident of
    // which column *names* it considers, and `status` is one of them.
    const candidates = promoteCandidates(
      changeSet([
        {
          table: 'cases',
          key: { columns: [{ column: 'id', value: maskedValue() }], token: 'x' },
          kind: 'insert',
          before: null,
          after: { id: maskedValue(), status: maskedValue() },
          changedColumns: ['id', 'status'],
          visibleColumns: ['id', 'status'],
          hasWrite: true,
        },
      ]),
      {},
    ).candidates;
    for (const candidate of candidates) {
      assert.doesNotMatch(candidate.expression, /•/, `a placeholder reached: ${candidate.expression}`);
      assert.doesNotMatch(candidate.description, /•/, `a placeholder reached: ${candidate.description}`);
    }
    // ...and the count assertion, which needs no value, still comes through.
    assert.ok(candidates.some((c) => /count\(inserted\(cases\)\) == 1/.test(c.expression)));
  });

  it('offers nothing for a row whose key is masked', () => {
    // The first guard here covered only the cross-row column candidates, and
    // this path went on emitting `single(updated(users, email = "••••••••"))`
    // for another hour. Dropping the row is the only honest option — without
    // the predicate, `single(updated(users))` asserts that exactly one row
    // changed, which is a different claim and usually a false one.
    const candidates = promoteCandidates(
      changeSet([
        {
          table: 'users',
          key: { columns: [{ column: 'email', value: maskedValue() }], token: 'x' },
          kind: 'update',
          before: { email: maskedValue(), plan: v('free') },
          after: { email: maskedValue(), plan: v('pro') },
          changedColumns: ['plan'],
          visibleColumns: ['plan'],
          hasWrite: true,
        },
      ]),
      {},
    ).candidates;
    for (const candidate of candidates) assert.doesNotMatch(candidate.expression, /•/);
    assert.equal(
      candidates.some((c) => /single\(updated\(users\)\)/.test(c.expression)),
      false,
      'a predicate-less form is not a weaker true claim, it is a different one',
    );
  });

  it('still names a row whose key is not masked', () => {
    const candidates = promoteCandidates(
      changeSet([
        {
          table: 'users',
          key: { columns: [{ column: 'email', value: v('a@b.c') }], token: 'x' },
          kind: 'update',
          before: { email: v('a@b.c'), plan: v('free') },
          after: { email: v('a@b.c'), plan: v('pro') },
          changedColumns: ['plan'],
          visibleColumns: ['plan'],
          hasWrite: true,
        },
      ]),
      {},
    ).candidates;
    assert.ok(candidates.some((c) => /email = "a@b\.c"/.test(c.expression)));
  });

  it('still lets an unmasked column beside it produce one', () => {
    const candidates = promoteCandidates(
      changeSet([
        {
          table: 'cases',
          key: { columns: [{ column: 'id', value: visible('text', 'c1') }], token: 'x' },
          kind: 'insert',
          before: null,
          after: { id: visible('text', 'c1'), status: visible('text', 'OPEN'), secret: maskedValue() },
          changedColumns: ['id', 'status', 'secret'],
          visibleColumns: ['id', 'status', 'secret'],
          hasWrite: true,
        },
      ]),
      {},
    ).candidates;
    assert.ok(candidates.some((c) => /status = "OPEN"/.test(c.expression)));
    for (const candidate of candidates) assert.doesNotMatch(candidate.expression, /•/);
  });

  const onlyWrite = (changed: RowChange) => {
    const promoted = promoteCandidates(changeSet([changed]), {});
    const write = promoted.candidates.find((c) => c.expression.startsWith('hasWrite('));
    assert.ok(write, promoted.candidates.map((c) => c.expression).join('\n'));
    return { write, withheld: promoted.withheld };
  };

  it('does not say no value changed when the only changed column is masked', () => {
    // Measured (maskprobe --json): "customers is written to without any value
    // changing (id cust_demo)" over passwordHash tsMaskProbe7q → tsMaskProbe8r,
    // beside a table summary of updated 1, writtenNoVisibleChange 0.
    const { write, withheld } = onlyWrite({
      table: 'customers',
      key: keyed('customers', 'id', 'cust_demo'),
      kind: 'update',
      before: { id: v('cust_demo'), passwordHash: maskedValue() },
      after: { id: v('cust_demo'), passwordHash: maskedValue() },
      changedColumns: ['passwordHash'],
      visibleColumns: ['passwordHash'],
      hasWrite: true,
    });
    assert.equal(
      write.description,
      'customers is written to and passwordHash changed, but its value is masked, so only the write is asserted (id cust_demo)',
    );
    // The expression asks only whether the row was written — true of this row,
    // needs no masked value, and names it by its unmasked key.
    assert.equal(write.expression, 'hasWrite(changes(customers, id = "cust_demo")) == true');
    assert.doesNotThrow(() => parse(write.expression));
    assert.deepEqual(withheld, ['customers.passwordHash']);
  });

  it('does not say no value changed when only a volatile column moved', () => {
    const { write } = onlyWrite({
      table: 'orders',
      key: keyed('orders', 'id', 'o1'),
      kind: 'update',
      before: { id: v('o1'), updated_at: v('2026-01-01 00:00:00+00', 'timestamptz') },
      after: { id: v('o1'), updated_at: v('2026-01-01 00:00:01+00', 'timestamptz') },
      changedColumns: ['updated_at'],
      visibleColumns: ['updated_at'],
      hasWrite: true,
    });
    assert.equal(
      write.description,
      'orders is written to and updated_at changed, but its value is different on every run, so only the write is asserted (id o1)',
    );
  });

  it('still says no value changed when none did', () => {
    const { write } = onlyWrite({
      table: 'orders',
      key: keyed('orders', 'id', 'o1'),
      kind: 'update',
      before: { id: v('o1'), status: v('OPEN') },
      after: { id: v('o1'), status: v('OPEN') },
      changedColumns: [],
      visibleColumns: [],
      hasWrite: true,
    });
    assert.equal(write.description, 'orders is written to without any value changing (id o1)');
  });
});

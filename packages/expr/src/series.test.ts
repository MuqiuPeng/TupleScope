/**
 * A series, and the two ways one lies.
 *
 * The first is filling the steps that changed nothing with the value the
 * database holds *now* — which is what the obvious source does, and it produces
 * a chart that looks right. The second is presenting a carried value as an
 * observed one. Both are pinned here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeSet, RowChange } from '@statescope/core';
import { masked, visible } from '@statescope/core';
import { seriesFor, SeriesSourceError, type SeriesStep } from './series.js';

const RENDERING = { DateStyle: 'ISO, MDY', TimeZone: 'UTC', bytea_output: 'hex', IntervalStyle: 'iso_8601', extra_float_digits: '1' };

function change(sku: string, before: string, after: string, maskIt = false): RowChange {
  return {
    table: 'stock',
    key: { columns: [{ column: 'sku', value: visible('text', sku) }], token: `t-${sku}` },
    kind: 'update',
    before: { sku: visible('text', sku), on_hand: maskIt ? masked('int4') : visible('int4', before) },
    after: { sku: visible('text', sku), on_hand: maskIt ? masked('int4') : visible('int4', after) },
    changedColumns: ['on_hand'],
    visibleColumns: ['on_hand'],
    hasWrite: true,
  };
}

function step(stepId: string, changes: readonly RowChange[]): SeriesStep {
  const set: ChangeSet = {
    captureMethod: 'mvcc-xmin',
    detection: 'write',
    fidelity: 'net',
    scope: {
      schema: 'public',
      database: 'test',
      allTables: true,
      tables: [{ table: 'stock', ignoreColumns: [], maskedColumns: [], keyStrategy: 'primary-key' }],
    },
    changes,
    rendering: RENDERING,
    warnings: [],
    durationMs: 1,
  };
  return { stepId, at: `2026-01-01T00:00:0${stepId.slice(-1)}.000Z`, changes: set };
}

/** X really goes 10 → 9 → (untouched) → 7. Y moves in the middle step. */
const RUN: SeriesStep[] = [
  step('s1', [change('X', '10', '9')]),
  step('s2', [change('Y', '100', '99')]),
  step('s3', [change('X', '9', '7')]),
];

const SOURCE = 'after(updated(stock, sku = "X").on_hand)';

describe('a series', () => {
  it('reports what each step observed, in order', () => {
    const points = seriesFor(RUN, SOURCE);
    assert.deepEqual(
      points.map((p) => [p.stepId, p.state, p.state === 'observed' || p.state === 'carried' ? p.value : null].slice(0, 2)),
      [['s1', 'observed'], ['s2', 'carried'], ['s3', 'observed']],
    );
  });

  it('carries the last observed value rather than the value it has now', () => {
    // The measurement this module exists for. X was 9 during step 2 and is 7
    // after the run. `after(single(rows(...)))` reports 7 for step 2 — the
    // present, drawn as history, and entirely plausible-looking.
    const middle = seriesFor(RUN, SOURCE)[1]!;
    assert.equal(middle.state, 'carried');
    if (middle.state !== 'carried') return;
    assert.equal(middle.value.state === 'visible' ? middle.value.text : null, '9');
    assert.notEqual(middle.value.state === 'visible' ? middle.value.text : null, '7');
    // ...and it says which step it actually came from, so a chart can draw it
    // as inference rather than observation.
    assert.equal(middle.since, 's1');
  });

  it('refuses a `rows(...)` source outright, rather than reading the present', () => {
    // Not a convention: this evaluator supplies no row lookup, so the refusal
    // is the same one any expression gets when the rows are not there.
    const points = seriesFor(RUN, 'after(rows(stock, sku = "X").on_hand)');
    assert.ok(points.every((p) => p.state === 'unevaluable'));
    assert.match(points[0]!.state === 'unevaluable' ? points[0]!.reason : '', /reads the rows as they are now/);
  });

  it('says `unobserved` before the first observation, not zero', () => {
    const late = seriesFor([step('s0', []), ...RUN], SOURCE);
    assert.equal(late[0]!.state, 'unobserved');
  });

  it('refuses a step where several rows match, rather than picking one', () => {
    const ambiguous = [step('s1', [change('X', '10', '9'), change('X2', '5', '4')])];
    const points = seriesFor(ambiguous, 'after(updated(stock).on_hand)');
    assert.equal(points[0]!.state, 'unevaluable');
    assert.match(points[0]!.state === 'unevaluable' ? points[0]!.reason : '', /2 rows matched/);
  });

  it('reports a masked column as observed-but-withheld, not as a gap', () => {
    // The honest answer, and a more useful one than either alternative. The
    // step *did* touch the row — that is observed. What is withheld is the
    // value, and the `Value` union means a chart cannot get a number out of it
    // however hard it tries: there is no `text` on the masked arm. So a point
    // can be drawn as "changed here, value not available" rather than vanishing,
    // which is what a gap would say and would be false.
    const points = seriesFor([step('s1', [change('X', '10', '9', true)])], SOURCE);
    assert.equal(points[0]!.state, 'observed');
    const point = points[0]!;
    if (point.state !== 'observed') return;
    assert.equal(point.value.state, 'masked');
    assert.equal(Object.hasOwn(point.value, 'text'), false, 'nothing to plot, by construction');
    assert.equal(point.value.pgType, 'int4', 'and it still says what type it was');
  });

  it('marks a step that recorded no observation, rather than skipping it', () => {
    const points = seriesFor([{ stepId: 's1' }, ...RUN], SOURCE);
    assert.equal(points[0]!.state, 'unevaluable');
  });

  it('refuses a source that is not a column', () => {
    assert.throws(() => seriesFor(RUN, 'count(updated(stock))'), SeriesSourceError);
    assert.throws(() => seriesFor(RUN, 'updated(stock)'), SeriesSourceError);
  });

  it('refuses a source that will not parse, naming it', () => {
    assert.throws(() => seriesFor(RUN, 'after(updated(stock'), /is not a valid expression/);
  });
});

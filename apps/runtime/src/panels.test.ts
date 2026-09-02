/**
 * What a chart is allowed to claim.
 *
 * The reason this evaluation is worth testing is the same reason `seriesFor`
 * exists: a chart is the easiest place in the product to draw something the run
 * never observed. A missing point interpolated, a value read from the database
 * as it is now, a line that carries on flat through a step nobody looked at —
 * each is plausible on screen and each is a lie.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayText, visible } from '@tuplescope/core';
import type { ChangeSet, Run, RowChange } from '@tuplescope/core';
import { panelFor, panelsFor } from './panels.js';

const change = (before: string | null, after: string | null): RowChange => ({
  table: 'stock',
  key: { columns: [{ column: 'sku', value: visible('text', 'X') }], token: 'X' },
  kind: before === null ? 'insert' : 'update',
  before: before === null ? null : { sku: visible('text', 'X'), on_hand: visible('int4', before) },
  after: after === null ? null : { sku: visible('text', 'X'), on_hand: visible('int4', after) },
  changedColumns: ['on_hand'],
  visibleColumns: ['on_hand'],
  hasWrite: true,
});

const changeSet = (changes: RowChange[]): ChangeSet => ({
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
  rendering: {
    DateStyle: 'ISO, MDY',
    TimeZone: 'UTC',
    bytea_output: 'hex',
    IntervalStyle: 'iso_8601',
    extra_float_digits: '1',
  },
  warnings: [],
  durationMs: 1,
});

const step = (stepId: string, changes: RowChange[] | undefined): never =>
  ({
    stepId,
    name: stepId,
    status: 'passed',
    startedAt: 't',
    finishedAt: `t-${stepId}`,
    request: { method: 'POST', url: '/x' },
    assertions: [],
    ...(changes ? { changes: changeSet(changes) } : {}),
  }) as never;

const run = (...steps: unknown[]): Run =>
  ({
    runId: 'r',
    scenarioId: 's',
    datasetId: 'd',
    startedAt: 't',
    status: 'passed',
    steps,
    variables: {},
    baseline: { probed: false },
  }) as never;

const SOURCE = 'after(updated(stock, sku = "X").on_hand)';
const spec = { title: 'Desk stock', unit: 'units', sources: { onHand: SOURCE } };

describe('a panel over a run', () => {
  it('reports what each step observed, in order', () => {
    const panel = panelFor(run(step('s1', [change('10', '9')]), step('s2', [change('9', '7')])), spec);
    assert.deepEqual(
      panel.series[0]!.points.map((p) => [
        p.stepId,
        p.state,
        // `displayText` rather than `.text`: a Value is a union, and only the
        // visible arm has text at all — which is the point of the union.
        'value' in p ? displayText(p.value) : null,
      ]),
      [
        ['s1', 'observed', '9'],
        ['s2', 'observed', '7'],
      ],
    );
  });

  it('marks a step that did not touch the row as carried, not as the value now', () => {
    // The failure this whole module is arranged to prevent. A `rows(...)` source
    // would answer 7 for the middle step — the value *after the run finished* —
    // and the chart would look perfectly plausible drawing it.
    const points = panelFor(
      run(step('s1', [change('10', '9')]), step('s2', []), step('s3', [change('9', '7')])),
      spec,
    ).series[0]!.points;
    assert.equal(points[1]!.state, 'carried');
    assert.equal(points[1]!.state === 'carried' && points[1]!.since, 's1');
  });

  it('says unobserved before the first observation rather than zero', () => {
    const points = panelFor(run(step('s0', []), step('s1', [change('10', '9')])), spec).series[0]!.points;
    assert.equal(points[0]!.state, 'unobserved');
  });

  it('reports a step that recorded no observation at all', () => {
    // A step that failed before the capture completed. On a chart this is
    // indistinguishable from "nothing changed" unless it says so.
    const points = panelFor(run(step('s1', undefined)), spec).series[0]!.points;
    assert.equal(points[0]!.state, 'unevaluable');
  });

  it('carries the title and unit through, and drops an absent unit', () => {
    assert.equal(panelFor(run(), spec).unit, 'units');
    assert.equal(Object.hasOwn(panelFor(run(), { title: 'T', sources: { a: SOURCE } }), 'unit'), false);
  });
});

describe('a source that cannot be evaluated', () => {
  it('is named as a problem rather than dropped', () => {
    // A silently dropped source is a chart that looks complete and is missing a
    // line — which is worse than a chart that says one line is missing.
    const panel = panelFor(run(step('s1', [change('10', '9')])), {
      title: 'T',
      sources: { good: SOURCE, bad: 'count(updated(stock))' },
    });
    assert.deepEqual(panel.series.map((s) => s.name), ['good']);
    assert.equal(panel.problems.length, 1);
    assert.equal(panel.problems[0]!.name, 'bad');
    assert.match(panel.problems[0]!.reason, /needs a column/);
  });

  it('costs its own line and not the panel', () => {
    const panel = panelFor(run(step('s1', [change('10', '9')])), {
      title: 'T',
      sources: { bad: 'after(updated(stock', good: SOURCE },
    });
    assert.equal(panel.series.length, 1, 'the working source still draws');
    assert.match(panel.problems[0]!.reason, /is not a valid expression/);
  });

  it('refuses a rows() source, which would read the database as it is now', () => {
    // `seriesFor` supplies no `lookupRows` at all, so this refuses through the
    // same code path that refuses it anywhere else — not by a convention anyone
    // has to remember.
    const panel = panelFor(run(step('s1', [change('10', '9')])), {
      title: 'T',
      sources: { now: 'after(rows(stock, sku = "X").on_hand)' },
    });
    assert.equal(panel.series[0]!.points[0]!.state, 'unevaluable');
  });
});

describe('panelsFor', () => {
  it('returns nothing when the workspace declares no panels', () => {
    assert.deepEqual(panelsFor(run(step('s1', [change('10', '9')]))), []);
    assert.deepEqual(panelsFor(run(step('s1', [change('10', '9')])), []), []);
  });

  it('evaluates every declared panel', () => {
    const panels = panelsFor(run(step('s1', [change('10', '9')])), [
      spec,
      { title: 'Second', sources: { onHand: SOURCE } },
    ]);
    assert.deepEqual(panels.map((p) => p.title), ['Desk stock', 'Second']);
  });
});

describe('a source that matched nothing at all', () => {
  it('says so, rather than drawing a flat nothing', () => {
    // Found on this repository's own workspace: a panel written against
    // `wal_shop` where the row is `wal_bookshop` produced an empty line and no
    // explanation. Every step `unobserved` is not "not yet" — it is "never".
    const panel = panelFor(run(step('s1', [change('10', '9')]), step('s2', [change('9', '7')])), {
      title: 'T',
      sources: { typo: 'after(updated(stock, sku = "NOPE").on_hand)' },
    });
    assert.equal(panel.problems.length, 1);
    assert.match(panel.problems[0]!.reason, /matched no row in any step/);
  });

  it('stays quiet while a run is still early, when unobserved means "not yet"', () => {
    // A source that has not been observed yet but will be must not be reported
    // as a mistake — so the signal is *every* step, not the first.
    const panel = panelFor(run(step('s1', []), step('s2', [change('10', '9')])), spec);
    assert.deepEqual(panel.problems, []);
  });

  it('stays quiet over a run with no steps at all', () => {
    assert.deepEqual(panelFor(run(), spec).problems, []);
  });
});

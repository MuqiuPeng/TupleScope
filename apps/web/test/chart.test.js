/**
 * That the picture says what the run observed, and nothing more.
 *
 * A chart is the easiest place in this product to draw a claim nobody made. The
 * three ways to do it are all natural: bridge a gap, carry a flat line through a
 * step nobody looked at without saying so, or squash a series that never moved
 * onto the axis so it reads as absent. Each looks plausible on screen.
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { chartGeometry, axisLabels } = require('../public/chart.js');

const observed = (stepId, text) => ({
  stepId,
  state: 'observed',
  value: { state: 'visible', pgType: 'int4', text },
});
const carried = (stepId, text, since) => ({
  stepId,
  state: 'carried',
  since,
  value: { state: 'visible', pgType: 'int4', text },
});
const gap = (stepId, state) => ({ stepId, state });

const panel = (...points) => ({ title: 'T', series: [{ name: 'onHand', points }], problems: [] });

describe('placing points', () => {
  it('spreads steps across the plot and maps values to the range', () => {
    const g = chartGeometry(panel(observed('s1', '10'), observed('s2', '20')), { width: 200, height: 100 });
    const [a, b] = g.series[0].points;
    assert.ok(b.x > a.x, 'later steps sit to the right');
    assert.ok(b.y < a.y, 'a larger value sits higher');
    assert.deepEqual([a.value, b.value], [10, 20]);
  });

  it('centres a single step rather than pinning it to the left edge', () => {
    // The centre of the *plot area*, which starts after the axis gutter — not
    // the centre of the canvas.
    const { PLOT } = require('../public/chart.js');
    const width = 200;
    const middle = PLOT.left + (width - PLOT.left - PLOT.right) / 2;
    assert.equal(chartGeometry(panel(observed('s1', '5')), { width, height: 100 }).series[0].points[0].x, middle);
  });

  it('gives a flat series room, so "it never moved" does not read as "no data"', () => {
    // A balance that did not change is a real answer, and drawing it on the
    // baseline reads as an empty chart.
    const g = chartGeometry(panel(observed('s1', '100'), observed('s2', '100')), { height: 100 });
    assert.notEqual(g.range.min, g.range.max);
    for (const p of g.series[0].points) {
      assert.ok(p.y > 12 && p.y < 88, `y=${p.y} should sit inside the plot, not on an edge`);
    }
  });
});

describe('what is not drawn', () => {
  it('places no point for a step with nothing observed', () => {
    const g = chartGeometry(panel(gap('s1', 'unobserved'), observed('s2', '5')));
    assert.equal(g.series[0].points[0].x, undefined);
    assert.equal(g.series[0].points[0].state, 'unobserved');
  });

  it('does not bridge a gap', () => {
    // The line must break where the run stopped knowing. A single path through
    // s1 and s3 asserts a value for s2 that nothing observed.
    const g = chartGeometry(
      panel(observed('s1', '10'), observed('s2', '12'), gap('s3', 'unevaluable'), observed('s4', '30'), observed('s5', '31')),
    );
    const spans = g.series[0].segments.map((seg) => seg.points.map((p) => p.stepId));
    // Two runs of two, either side. No segment may contain a step from both.
    assert.deepEqual(spans, [['s1', 's2'], ['s4', 's5']]);
  });

  it('draws no line at all across an isolated point', () => {
    // Two points with a gap between them are two dots, not a line.
    const g = chartGeometry(panel(observed('s1', '10'), gap('s2', 'unevaluable'), observed('s3', '30')));
    assert.deepEqual(g.series[0].segments, []);
    assert.equal(g.series[0].points.filter((p) => p.x !== undefined).length, 2, 'both dots are still placed');
  });

  it('places no point for a masked value', () => {
    // Masked crosses as masked and carries no text. A chart cannot plot what it
    // was never given, and must not plot zero instead.
    const g = chartGeometry(
      panel({ stepId: 's1', state: 'observed', value: { state: 'masked', pgType: 'numeric' } }),
    );
    assert.equal(g.series[0].points[0].x, undefined);
    // ...and the point survives, still saying it was observed. "Observed a
    // value we cannot draw" and "observed nothing" are different claims, and
    // dropping the series would make the page unable to tell them apart.
    assert.equal(g.series[0].points[0].state, 'observed');
  });

  it('places no point for a value that is not a number', () => {
    const g = chartGeometry(panel(observed('s1', 'REFUNDED')));
    assert.equal(g.series[0].points[0].x, undefined);
    assert.equal(g.range, null, 'nothing plottable means no range at all');
  });

  it('returns an empty chart rather than throwing when a panel has no points', () => {
    const g = chartGeometry({ title: 'T', series: [], problems: [] });
    assert.deepEqual({ range: g.range, series: g.series, steps: g.steps }, { range: null, series: [], steps: [] });
  });
});

describe('observed against carried', () => {
  it('splits the line where observation stops, so inference is drawable as inference', () => {
    const g = chartGeometry(panel(observed('s1', '10'), carried('s2', '10', 's1'), observed('s3', '7')));
    // s1 alone is a dot, not a line. What is drawn is a carried run into s2 and
    // an observed run into s3 — so the inference is visibly the middle stretch.
    assert.deepEqual(g.series[0].segments.map((seg) => seg.state), ['carried', 'observed']);
    assert.deepEqual(
      g.series[0].segments.map((seg) => seg.points.map((p) => p.stepId)),
      [['s1', 's2'], ['s2', 's3']],
    );
  });

  it('joins each segment to the previous point, so the line does not break at the change', () => {
    // The change of style is the signal. A gap there would read as missing data,
    // which is a different claim from "nothing touched this row".
    const g = chartGeometry(panel(observed('s1', '10'), carried('s2', '10', 's1')));
    assert.equal(g.series[0].segments.length, 1);
    const [only] = g.series[0].segments;
    assert.equal(only.state, 'carried');
    assert.deepEqual(only.points.map((p) => p.stepId), ['s1', 's2'], 'it starts at the last observation');
  });

  it('drops a segment of one point, which is a dot and not a line', () => {
    const g = chartGeometry(panel(observed('s1', '10'), gap('s2', 'unobserved')));
    assert.deepEqual(g.series[0].segments, []);
    assert.equal(g.series[0].points[0].x !== undefined, true, 'the point itself is still placed');
  });
});

describe('two series share one range', () => {
  it('scales both against the same extent, so they can be compared', () => {
    const g = chartGeometry({
      title: 'T',
      problems: [],
      series: [
        { name: 'onHand', points: [observed('s1', '0'), observed('s2', '100')] },
        { name: 'reserved', points: [observed('s1', '50'), observed('s2', '50')] },
      ],
    });
    assert.deepEqual([g.range.min, g.range.max], [0, 100]);
    const [low, high] = g.series[0].points;
    const [mid] = g.series[1].points;
    assert.ok(mid.y < low.y && mid.y > high.y, 'the middle value sits between the two extremes');
  });
});

describe('axisLabels', () => {
  it('labels the extremes, and rounds only when it has to', () => {
    assert.deepEqual(axisLabels({ min: 0, max: 100 }).map((l) => l.text), ['100', '0']);
    assert.deepEqual(axisLabels({ min: 0.5, max: 1.25 }).map((l) => l.text), ['1.25', '0.50']);
  });

  it('says nothing when there is no range', () => {
    assert.deepEqual(axisLabels(null), []);
  });
});

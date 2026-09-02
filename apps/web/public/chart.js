/**
 * A run's chart, as geometry.
 *
 * Kept apart from the DOM so the one thing worth checking can be checked: that
 * the picture says what the run observed and nothing more. A chart is the
 * easiest place in this product to draw a claim nobody made — interpolate a
 * missing point, carry a line flat through a step nobody looked at, or fill a
 * gap from the value now — and each of those looks perfectly plausible.
 *
 * So the shape of the answer is deliberately explicit: every point is placed
 * with the state the run gave it, and the segments between them are split by
 * that state rather than drawn as one path. A reader can see where the tool
 * stopped observing, because the line changes there.
 */

const PLOT = { top: 12, right: 12, bottom: 22, left: 44 };

/** A point with a number to plot, or null for one there is nothing to plot. */
function valueOf(point) {
  if (point.state !== 'observed' && point.state !== 'carried') return null;
  const text = point.value?.state === 'visible' ? point.value.text : null;
  if (text === null || text === undefined) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The vertical range, padded so a flat line is not drawn on the axis.
 *
 * A series that never moves is a real answer — the balance did not change —
 * and squashing it onto the baseline reads as "no data" instead.
 */
function extent(values) {
  if (values.length === 0) return null;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  return { min, max };
}

/**
 * Turns evaluated series into positioned marks.
 *
 * Segments are split wherever the state changes, so an observed run of points
 * and a carried one are different paths and can be drawn differently. A gap —
 * `unobserved`, `unevaluable`, or a value that is not a number — ends the
 * current segment rather than being bridged.
 */
function chartGeometry(panel, { width = 320, height = 140 } = {}) {
  const steps = panel.series[0]?.points ?? [];
  const plotWidth = Math.max(1, width - PLOT.left - PLOT.right);
  const plotHeight = Math.max(1, height - PLOT.top - PLOT.bottom);

  const everyValue = panel.series.flatMap((s) => s.points.map(valueOf).filter((v) => v !== null));
  const range = extent(everyValue);
  if (!range) {
    // Nothing plottable — every value masked, or textual, or nothing observed
    // yet. The points still come back, carrying their states and no
    // coordinates, because "this step observed a value we cannot draw" is a
    // different thing from "this step observed nothing", and dropping the
    // series makes the page unable to tell them apart.
    return {
      width,
      height,
      range: null,
      series: panel.series.map((s) => ({
        name: s.name,
        points: s.points.map((point) => ({ stepId: point.stepId, state: point.state })),
        segments: [],
      })),
      steps: steps.map((p) => p.stepId),
    };
  }

  const x = (index) => PLOT.left + (steps.length === 1 ? plotWidth / 2 : (index / (steps.length - 1)) * plotWidth);
  const y = (value) => PLOT.top + plotHeight - ((value - range.min) / (range.max - range.min)) * plotHeight;

  const series = panel.series.map((s) => {
    const points = s.points.map((point, index) => {
      const value = valueOf(point);
      return {
        stepId: point.stepId,
        state: point.state,
        ...(value === null ? {} : { x: x(index), y: y(value), value }),
      };
    });

    // Split on state, not just on gaps: a carried run is inference and is drawn
    // as inference, which is the whole reason the payload distinguishes it.
    const segments = [];
    let current = null;
    for (const point of points) {
      if (point.x === undefined) {
        current = null;
        continue;
      }
      if (!current || current.state !== point.state) {
        // Join to the previous point so the line does not break at the moment
        // observation stops — the change of style is the signal, not a gap.
        const previous = current?.points.at(-1);
        current = { state: point.state, points: previous ? [previous] : [] };
        segments.push(current);
      }
      current.points.push(point);
    }

    return { name: s.name, points, segments: segments.filter((seg) => seg.points.length > 1) };
  });

  return { width, height, range, series, steps: steps.map((p) => p.stepId) };
}

/** The axis labels: the extremes only, because a panel this size fits no more. */
function axisLabels(range) {
  if (!range) return [];
  const round = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  return [
    { at: 'max', text: round(range.max) },
    { at: 'min', text: round(range.min) },
  ];
}

if (typeof module !== 'undefined') {
  module.exports = { chartGeometry, axisLabels, PLOT };
}

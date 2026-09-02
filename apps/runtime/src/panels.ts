/**
 * Charts, evaluated here rather than in the page.
 *
 * The repository names what a panel is about; the host works out the numbers and
 * draws them. See docs/panel-mods-design.md §13 for why it is this way round —
 * briefly, a renderer able to set its own typography inside the evidence panel
 * could reproduce this product's own verdict over data that does not say it, and
 * a chart is not worth that.
 *
 * `seriesFor` does the part that matters and is already built: it distinguishes
 * a step that observed a value from one that did not, refuses a `rows(...)`
 * source so a chart cannot be filled in from the database as it is *now*, and
 * refuses a step where several rows match rather than picking one. Everything
 * here is the adapter around it.
 */

import { seriesFor, SeriesSourceError, type SeriesPoint } from '@tuplescope/expr';
import type { PanelSpec } from '@tuplescope/workspace';
import type { Run } from '@tuplescope/core';

export interface PanelSeries {
  readonly name: string;
  readonly points: ReadonlyArray<SeriesPoint>;
}

export interface PanelData {
  readonly title: string;
  readonly unit?: string;
  readonly series: ReadonlyArray<PanelSeries>;
  /**
   * Sources that could not be evaluated at all, named.
   *
   * Kept beside the series rather than thrown, so one bad expression costs its
   * own line and not the whole panel — and so it is *visible*. A source silently
   * dropped is a chart that looks complete and is missing a line.
   */
  readonly problems: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/**
 * One panel's worth of data from a run.
 *
 * Steps are taken in the order the run recorded them, which is the order they
 * happened. A step that failed before observation has no `changes`, and
 * `seriesFor` reports that as `unevaluable` rather than as a gap — the two look
 * identical on a chart and mean opposite things.
 */
export function panelFor(run: Run, spec: PanelSpec): PanelData {
  const steps = run.steps.map((step) => ({
    stepId: step.stepId,
    ...(step.finishedAt ? { at: step.finishedAt } : {}),
    ...(step.changes ? { changes: step.changes } : {}),
  }));

  const series: PanelSeries[] = [];
  const problems: Array<{ name: string; reason: string }> = [];
  for (const [name, source] of Object.entries(spec.sources)) {
    try {
      const points = seriesFor(steps, source);
      series.push({ name, points });
      // Every step `unobserved` means the selector matched no row anywhere in
      // the run — a mistyped key, or a predicate nothing satisfies. That is a
      // different thing from "not observed *yet*", and on a chart the two are
      // the same flat nothing. Measured on this repository's own workspace: a
      // panel written against `wal_shop`, where the row is `wal_bookshop`, drew
      // an empty line and said nothing about why.
      if (points.length > 0 && points.every((point) => point.state === 'unobserved')) {
        problems.push({
          name,
          reason:
            'matched no row in any step of this run — check the predicate, ' +
            'or run a dataset that writes to it',
        });
      }
    } catch (error) {
      // A `SeriesSourceError` is a statement about the expression — unparseable,
      // or selecting a row or a scalar where a column was needed. Anything else
      // is a bug here and is not swallowed.
      if (!(error instanceof SeriesSourceError)) throw error;
      problems.push({ name, reason: error.message });
    }
  }

  return { title: spec.title, ...(spec.unit ? { unit: spec.unit } : {}), series, problems };
}

/** Every panel the workspace declares, for one run. Empty when none are declared. */
export function panelsFor(run: Run, specs: ReadonlyArray<PanelSpec> = []): PanelData[] {
  return specs.map((spec) => panelFor(run, spec));
}

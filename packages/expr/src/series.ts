/**
 * One expression, evaluated once per step — the shape a panel needs to draw.
 *
 * Everything else in this package answers a question about *a* step. A chart
 * asks the same question of every step and puts the answers in order, and the
 * whole difficulty is the steps where the answer is "this step did not touch
 * that row".
 *
 * The tempting source for a series is `rows(...)`, because it always answers.
 * Measured, on a row whose real history is `10 → 9 → untouched → 7`:
 * `after(single(rows(stock, sku = "X")).on_hand)` reports **7** for the middle
 * step — the value *now*, after the run finished. A chart built on it draws the
 * final value at every step that did not touch the row, and looks perfectly
 * plausible doing it.
 *
 * So this evaluator supplies no `lookupRows` at all. That is not a convention
 * to remember: a `rows(...)` source refuses, by the same code path that refuses
 * it anywhere else, because the rows are simply not there to read. A series can
 * only be built from what each step actually observed.
 */

import type { ChangeSet, Value } from '@tuplescope/core';
import { evaluateExpr, Unevaluable } from './evaluate.js';
import { ExprSyntaxError, parse } from './parse.js';

/** The minimum a step has to be, so this does not depend on the run's shape. */
export interface SeriesStep {
  readonly stepId: string;
  /** When the step finished, for the axis. Absent is fine; the order is the order. */
  readonly at?: string;
  /** Absent when the step failed before observation completed. */
  readonly changes?: ChangeSet;
}

export type SeriesPoint = {
  readonly stepId: string;
  readonly at?: string;
} & (
  | {
      /** This step watched the row and this is what it saw. */
      readonly state: 'observed';
      readonly value: Value;
    }
  | {
      /**
       * This step did not touch the row, so the value is the last one that was
       * observed — carried, and labelled as carried.
       *
       * Inference, and marked as such so a chart can draw it differently. The
       * alternative is a gap, which reads as "the value was missing" when what
       * happened is "nothing changed" — and the alternative to *that* is
       * silently filling from the present database, which is the one thing this
       * module exists to prevent.
       */
      readonly state: 'carried';
      readonly value: Value;
      /** The step the value was actually observed in. */
      readonly since: string;
    }
  | {
      /** Nothing has been observed yet, so there is not even a value to carry. */
      readonly state: 'unobserved';
    }
  | {
      /** The question could not be answered here. Includes a masked column. */
      readonly state: 'unevaluable';
      readonly reason: string;
    }
);

export class SeriesSourceError extends Error {
  override readonly name = 'SeriesSourceError';
}

/**
 * Evaluates `source` against each step in order.
 *
 * `source` must select a **column**, not a row and not a scalar — for example
 * `after(updated(stock, sku = "X").on_hand)`. Deliberately without `single()`:
 * `single()` throws when a step did not touch the row, which is the ordinary
 * case for most steps and not an error. A column selector answers the same
 * question with an empty list, which is exactly the distinction a series needs.
 */
export function seriesFor(
  steps: ReadonlyArray<SeriesStep>,
  source: string,
): ReadonlyArray<SeriesPoint> {
  let expr;
  try {
    expr = parse(source);
  } catch (error) {
    throw new SeriesSourceError(
      error instanceof ExprSyntaxError
        ? `\`${source}\` is not a valid expression: ${error.message}`
        : String(error),
    );
  }

  const out: SeriesPoint[] = [];
  let last: { value: Value; since: string } | undefined;

  for (const step of steps) {
    const at = step.at === undefined ? {} : { at: step.at };
    const head = { stepId: step.stepId, ...at };

    if (!step.changes) {
      out.push({ ...head, state: 'unevaluable', reason: 'this step recorded no observation' });
      continue;
    }

    let result;
    try {
      // No `lookupRows`. A `rows(...)` source refuses here rather than reading
      // the database as it is now and reporting it as the value at this step.
      result = evaluateExpr(expr, { changes: step.changes, variables: {} });
    } catch (error) {
      if (error instanceof Unevaluable) {
        out.push({ ...head, state: 'unevaluable', reason: error.message });
        continue;
      }
      throw error;
    }

    if (result.kind !== 'column') {
      throw new SeriesSourceError(
        `\`${source}\` selects ${result.kind === 'scalar' ? 'a single number' : 'a set of rows'}, ` +
          'and a series needs a column — for example `after(updated(t, id = "x").amount)`.',
      );
    }
    if (result.values.length > 1) {
      // More than one row matched, so "the" value for this step is a choice
      // nobody made. Narrow the selector rather than picking one.
      out.push({
        ...head,
        state: 'unevaluable',
        reason: `${result.values.length} rows matched, so there is no single value for this step. Narrow the selector with a predicate.`,
      });
      continue;
    }

    const value = result.values[0];
    if (value === undefined || value === null) {
      // The step did not touch the row. Carry the last observation forward,
      // labelled — or say plainly that there is nothing yet to carry.
      out.push(last ? { ...head, state: 'carried', value: last.value, since: last.since } : { ...head, state: 'unobserved' });
      continue;
    }

    out.push({ ...head, state: 'observed', value });
    last = { value, since: step.stepId };
  }

  return out;
}

/**
 * What every surface needs to offer a row to another tool.
 *
 * Three things, computed once: where the row is, the statement that names it,
 * and — when there is none — the sentence that says why. Each surface used to
 * derive its own; the CLI and the web page disagreed about masked values, and
 * the web page emitted `col = NULL`.
 *
 * The statement is rendered here rather than carried on the locator, because a
 * locator is structure and a statement is text produced under session settings.
 * `ChangeSet.rendering` records what those actually were, so `portable` can be
 * a fact rather than an assumption.
 */

import type { ChangeSet, RowChange } from './changeset.js';
import { explain, locatorFor, type DatabaseLocator } from './locator.js';
import { renderSelect, UnrenderableValue } from './sql.js';

/** The pinned settings a capture is expected to have used. Mirrors the adapter's. */
const EXPECTED_RENDERING: Readonly<Record<string, string>> = {
  DateStyle: 'ISO, MDY',
  TimeZone: 'UTC',
  bytea_output: 'hex',
  IntervalStyle: 'iso_8601',
  extra_float_digits: '1',
};

export interface RowHandoff {
  readonly locator: DatabaseLocator;
  /** `SELECT * FROM …;` — absent when the row cannot be addressed. */
  readonly sql?: string;
  /** One sentence naming the cause and the fix. Absent when there is nothing to explain. */
  readonly reason?: string;
  /**
   * Whether the values in `sql` were printed under the settings that make them
   * mean the same thing elsewhere.
   *
   * False does not make the statement wrong here — it came from this database
   * and goes back to it. It makes it unsafe to hand to a tool whose session
   * renders differently, which is the entire purpose of handing it over.
   */
  readonly portable: boolean;
  /** The row is addressable and known to be gone; an empty result is the answer. */
  readonly absent?: true;
}

export function handoffFor(change: RowChange, changes: ChangeSet): RowHandoff {
  const locator = locatorFor(change, changes);
  const portable = Object.entries(EXPECTED_RENDERING).every(
    ([name, want]) => changes.rendering[name] === want,
  );

  if (locator.state === 'unavailable') {
    return { locator, reason: explain(locator.reason), portable };
  }

  try {
    const sql = renderSelect(locator.location.schema, locator.table, locator.key.columns);
    return {
      locator,
      sql,
      portable,
      ...(locator.state === 'usable-absent'
        ? {
            absent: true as const,
            reason:
              locator.kind === 'delete'
                ? 'This row was deleted during the step. The statement is correct and will return no rows — that is the expected result.'
                : 'This row left the watched range during the step. The statement addresses it by key and will return it if it still exists outside that range.',
          }
        : {}),
    };
  } catch (error) {
    // The locator said the key was addressable and the renderer disagreed —
    // a NUL byte, an empty key. Reported rather than thrown, because one
    // unrenderable row must not take down the panel that lists two hundred.
    if (error instanceof UnrenderableValue) {
      return { locator, reason: error.message, portable };
    }
    throw error;
  }
}

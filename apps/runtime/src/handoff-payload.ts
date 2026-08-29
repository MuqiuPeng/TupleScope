import type { Run } from '@tuplescope/core';
import { handoffFor } from '@tuplescope/core';

/**
 * Attaches the row handoff to every change on the way out.
 *
 * Computed here, once, rather than in the browser. The page has no build step,
 * so a renderer shipped to it would be a second implementation of the SQL
 * quoting rules — which is what it was, and it emitted `col = NULL` for a null
 * key and never escaped a backslash. Now the string the reader copies is the
 * same string every other surface produces, from the same function.
 */
export function withHandoffs(run: Run): unknown {
  return {
    ...run,
    steps: run.steps.map((step) => {
      const changes = step.changes;
      if (!changes) return step;
      return {
        ...step,
        changes: {
          ...changes,
          changes: changes.changes.map((change) => ({
            ...change,
            handoff: handoffFor(change, changes),
          })),
        },
      };
    }),
  };
}

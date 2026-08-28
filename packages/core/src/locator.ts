/**
 * A precise address for one row, and nothing else.
 *
 * The point of the type is what it refuses to carry. Not a DSN, not a
 * connection, not SQL text: the target tool manages its own connection, and a
 * statement is a value *plus* the session settings that print it, which a
 * locator by definition cannot see. What it carries is where the row is and how
 * to name it — and, when it cannot, why.
 *
 * Every `usable` arm names a place. An earlier draft let `usable` sit beside an
 * unknown location, so a consumer could destructure a usable locator and find
 * no database to address; the two states are one state, and the type says so.
 */

import type { KeyStrategy, Value } from './value.js';
import type { ChangeSet, RowChange } from './changeset.js';
import { isVisible, type UnknownReason } from './value.js';
import type { PredicateColumn, PredicateOp } from './sql.js';

/** Where a statement can be run. Not optional: a locator without one is unusable. */
export interface KnownLocation {
  readonly database: string;
  readonly schema: string;
}

export interface KeyPredicate {
  readonly columns: ReadonlyArray<PredicateColumn>;
}

export type DatabaseLocator =
  /** The row is there. Open it. */
  | {
      readonly state: 'usable';
      readonly location: KnownLocation;
      readonly table: string;
      readonly key: KeyPredicate;
    }
  /**
   * The address is exact and the row is gone. Opening it is still correct — the
   * empty result *is* the answer.
   *
   * Its own arm rather than a flag on the arm above, so a consumer that forgets
   * the case fails to compile. Forgetting it renders an empty table with no
   * explanation, which reads as a broken handoff.
   */
  | {
      readonly state: 'usable-absent';
      readonly location: KnownLocation;
      readonly table: string;
      readonly key: KeyPredicate;
      readonly kind: 'delete' | 'left-scope';
    }
  | { readonly state: 'unavailable'; readonly reason: LocatorUnavailable };

export type LocatorUnavailable =
  | { readonly reason: 'masked-key'; readonly columns: ReadonlyArray<string> }
  /**
   * Derived from `Value`, so it cannot drift.
   *
   * An earlier draft wrote this as a conditional type whose test is never true,
   * which resolves to the constant on the right — it reads like a derivation
   * and is a hand-maintained literal.
   */
  | { readonly reason: 'unknown-value'; readonly columns: ReadonlyArray<string>; readonly cause: UnknownReason }
  | { readonly reason: 'no-stable-key'; readonly keyStrategy: KeyStrategy }
  | { readonly reason: 'location-unknown' }
  /** Set by a target, never by core: what one tool can address, another cannot. */
  | { readonly reason: 'target-cannot-address'; readonly target: string; readonly detail: string };

/**
 * `key-not-unique` is deliberately absent.
 *
 * It described a state that can no longer be constructed: the identity query
 * rejects an index whole rather than narrowing it, so a key is either unique or
 * absent. A reason nothing can produce is a branch consumers write and never
 * exercise.
 */

/** How this column will be matched. Derived, never stored beside the value. */
export function opFor(value: Value): PredicateOp {
  return isVisible(value) && value.text === null ? 'is-not-distinct-from' : '=';
}

/**
 * The locator for one reported change.
 *
 * Built from what the capture observed — never from a table name supplied by
 * configuration. That is the only thing standing between this and a repository
 * pointing a target at a table the scenario never touched.
 */
export function locatorFor(change: RowChange, changes: ChangeSet): DatabaseLocator {
  const { schema, database } = changes.scope;
  if (!schema || !database) return { state: 'unavailable', reason: { reason: 'location-unknown' } };

  const spec = changes.scope.tables.find((t) => t.table === change.table);
  if (!change.key || change.key.columns.length === 0) {
    return {
      state: 'unavailable',
      reason: { reason: 'no-stable-key', keyStrategy: spec?.keyStrategy ?? 'full-row-multiset' },
    };
  }

  const maskedColumns = change.key.columns.filter((c) => c.value.state === 'masked').map((c) => c.column);
  if (maskedColumns.length > 0) {
    return { state: 'unavailable', reason: { reason: 'masked-key', columns: maskedColumns } };
  }

  const unreadable = change.key.columns.filter((c) => c.value.state === 'unknown');
  if (unreadable.length > 0) {
    const first = unreadable[0]!.value;
    return {
      state: 'unavailable',
      reason: {
        reason: 'unknown-value',
        columns: unreadable.map((c) => c.column),
        cause: first.state === 'unknown' ? first.reason : 'unreadable',
      },
    };
  }

  const key: KeyPredicate = {
    columns: change.key.columns.map((c) => ({ name: c.column, value: c.value })),
  };
  const location: KnownLocation = { database, schema };

  // The key only — never the watch predicate. A `left-scope` row is precisely
  // the row that predicate now excludes, so carrying it would produce an
  // address guaranteed to return nothing, for a reason no reader could see.
  if (change.kind === 'delete' || change.kind === 'left-scope') {
    return { state: 'usable-absent', location, table: change.table, key, kind: change.kind };
  }
  return { state: 'usable', location, table: change.table, key };
}

/** One sentence: what is wrong, and what would fix it. */
export function explain(reason: LocatorUnavailable): string {
  switch (reason.reason) {
    case 'masked-key':
      return (
        `This row is identified by ${list(reason.columns)}, which ${reason.columns.length === 1 ? 'is' : 'are'} ` +
        'masked at capture, so nothing can address it. Remove the column from `maskColumns` to open rows of this table.'
      );
    case 'unknown-value':
      return (
        `This run could not read ${list(reason.columns)} (${reason.cause}), so the row cannot be named. ` +
        'Re-run the scenario; if it persists, the value is not recoverable from the write-ahead log alone.'
      );
    case 'no-stable-key':
      return reason.keyStrategy === 'full-row-multiset'
        ? 'This table has neither a primary key nor a unique index over NOT NULL columns, so its rows can be counted but not addressed individually. Add one to open rows here.'
        : // The scope claims a key strategy and the change carries no key —
          // contradictory, and worth saying so rather than restating the
          // strategy name at a reader who cannot act on it.
          `This row carries no key even though \`${reason.keyStrategy}\` was expected for the table. ` +
          'That is a capture bug, not a schema problem: please report it with the run.';
    case 'location-unknown':
      return 'This run did not record which database and schema it watched, so a statement built from it could address the wrong one. Re-run it with a current build.';
    case 'target-cannot-address':
      return `${reason.target} cannot open this row: ${reason.detail}`;
  }
}

function list(columns: ReadonlyArray<string>): string {
  return columns.map((c) => `\`${c}\``).join(', ');
}

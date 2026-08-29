/**
 * Turns what a step actually changed into assertions you can keep.
 *
 * This is the loop the product exists for. Ask a backend engineer why they
 * would not just write pytest and a few SQL assertions, and the honest answer
 * is that a hand-written test is more precise — its only weakness is that you
 * have to know the answer before you write it. Running first, then promoting
 * what you saw, is the part a test file cannot do.
 *
 * The one thing that makes or breaks it: **generated ids must not be baked in**.
 * A candidate reading `id = "pay_ltx3k01"` passes exactly once and then fails
 * on every later run, which teaches people that the feature is broken. So every
 * literal is checked against the run's captured variables first, and a match
 * becomes `{{payment_id}}`.
 */

import type { AssertionCandidate, ChangeSet, RowChange, Value, VisibleValue } from '@tuplescope/core';
import { displayText, isVisible } from '@tuplescope/core';
import { Decimal } from '@tuplescope/expr';

/** Columns that are never worth asserting on: they differ every run by design. */
const VOLATILE = /^(created_at|updated_at|inserted_at|modified_at|touched|last_seen|version|etag)$/i;

const NUMERIC = new Set(['numeric', 'decimal', 'int2', 'int4', 'int8', 'float4', 'float8']);

/**
 * Renders a value for an expression, preferring a variable reference.
 *
 * Reversed lookup rather than forward substitution: we have the literal and
 * want to know whether the run already has a name for it.
 */
function literalOf(
  value: Value | undefined,
  variables: Readonly<Record<string, string>>,
): string | null {
  // `null`, not a placeholder. Every caller drops the candidate rather than
  // writing something down, which is the only honest option: an assertion whose
  // expected literal is the redaction passes forever and establishes nothing.
  // Measured before this returned null: `single(updated(cards, id = "c1"))
  // .after.card_number == "••••••••"` was offered as a candidate.
  if (!isVisible(value)) return null;
  if (value.text === null) return 'null';
  for (const [name, captured] of Object.entries(variables)) {
    // `run` and `now` are built-ins that happen to be strings; matching against
    // them would produce nonsense like `id == {{now}}`.
    if (name === 'run' || name === 'now') continue;
    if (captured === value.text) return `{{${name}}}`;
  }
  if (NUMERIC.has(value.pgType) && Decimal.isDecimal(value.text)) return value.text;
  return JSON.stringify(value.text);
}

/** `id = {{payment_id}}` — the predicate that pins a candidate to one row. */
function predicateOf(
  change: RowChange,
  variables: Readonly<Record<string, string>>,
): string | null {
  if (!change.key || change.key.columns.length === 0) return null;
  const parts: string[] = [];
  for (const { column, value } of change.key.columns) {
    const literal = literalOf(value, variables);
    // One unwritable key column makes the whole predicate unwritable. A
    // predicate over the rest would name more rows than the one observed.
    if (literal === null) return null;
    parts.push(`${column} = ${literal}`);
  }
  return parts.join(' and ');
}

function describeKey(change: RowChange): string {
  if (!change.key) return `a row in ${change.table}`;
  return change.key.columns.map((c) => `${c.column} ${displayText(c.value)}`).join(', ');
}

/**
 * Candidates for one changed row, most specific first.
 *
 * Specific ones go first because they are what the user was looking at when
 * they clicked; the coarser counts are there for when the exact row is not the
 * point.
 */
function countCaveat(
  detection: ChangeSet['detection'],
  table?: string,
): AssertionCandidate['caveat'] | undefined {
  if (detection === 'write') return undefined;
  return {
    code: 'reduced-fidelity',
    ...(table ? { table } : {}),
    message:
      'Counting mutations needs write detection. Under a value comparison this ' +
      'assertion will refuse to run rather than report a result it cannot justify.',
  };
}

/**
 * Counts of rows inserted into, or deleted from, each table.
 *
 * Per table rather than per row, with the real number: a refund that writes two
 * ledger legs must offer `== 2`, once. Offering `== 1` twice is both duplicated
 * and false, and a candidate that fails the moment you keep it is worse than no
 * candidate at all.
 */
function countCandidates(
  withheld: string[],
  changes: ChangeSet,
  variables: Readonly<Record<string, string>>,
): AssertionCandidate[] {
  const out: AssertionCandidate[] = [];
  const caveat = countCaveat(changes.detection);

  for (const [kind, verb, noun] of [
    ['insert', 'inserted', 'inserted into'],
    ['delete', 'deleted', 'deleted from'],
  ] as const) {
    const matching = changes.changes.filter(
      (c) => c.kind === kind || c.kind === (kind === 'insert' ? 'entered-scope' : 'left-scope'),
    );
    const byTable = new Map<string, RowChange[]>();
    for (const change of matching) {
      if (!byTable.has(change.table)) byTable.set(change.table, []);
      byTable.get(change.table)!.push(change);
    }

    for (const [table, rows] of byTable) {
      const index = changes.changes.indexOf(rows[0]!);
      out.push({
        expression: `count(${verb}(${table})) == ${rows.length}`,
        description: `${rows.length === 1 ? 'exactly one row is' : `${rows.length} rows are`} ${noun} ${table}`,
        changeIndex: index,
        ...(caveat ? { caveat } : {}),
      });

      if (kind !== 'insert') continue;
      // A discriminating column narrows the count to something meaningful —
      // counted across the whole table, again, not per row.
      const columns = new Set<string>();
      for (const change of rows) {
        for (const column of Object.keys(change.after ?? {})) {
          if (/^(type|status|kind|state|reason|currency|category)$/i.test(column)) columns.add(column);
        }
      }
      for (const column of columns) {
        // One row without a readable value disqualifies the column: the count
        // would be over the rows that happened to be readable, presented as a
        // count over all of them.
        if (rows.some((r) => !isVisible(r.after?.[column]))) {
          withheld.push(`${table}.${column}`);
          continue;
        }
        const textOf = (r: RowChange): string | null => {
          const value = r.after?.[column];
          return isVisible(value) ? value.text : null;
        };
        const values = new Set(rows.map(textOf).filter((t): t is string => t != null));
        for (const value of values) {
          const n = rows.filter((r) => textOf(r) === value).length;
          const sample = rows.find((r) => textOf(r) === value)!.after![column]!;
          const literal = literalOf(sample, variables);
          if (literal === null) continue;
          out.push({
            expression: `count(inserted(${table}).where(${column} = ${literal})) == ${n}`,
            description: `${n} ${table} row${n === 1 ? '' : 's'} with ${column} ${value}`,
            changeIndex: index,
            ...(caveat ? { caveat } : {}),
          });
        }
      }
    }
  }
  return out;
}

function forChange(
  withheld: string[],
  change: RowChange,
  index: number,
  variables: Readonly<Record<string, string>>,
  detection: ChangeSet['detection'],
): AssertionCandidate[] {
  const out: AssertionCandidate[] = [];
  // A row keyed by a masked column cannot be named, so none of the per-row
  // candidates below can be written. Dropping them is the only honest option:
  // without the predicate, `single(updated(users))` is not a weaker version of
  // the same claim — it asserts that exactly one row changed, which is a
  // different and probably false thing.
  //
  // This is the second place in this file that had to learn about masking. The
  // first guard covered the cross-row column candidates, and this path went on
  // emitting `email = "••••••••"` regardless — which is what an optional
  // boolean on a value costs.
  const predicate = predicateOf(change, variables);
  if (change.key && change.key.columns.length > 0 && predicate === null) {
    withheld.push(`${change.table} (key)`);
    return out;
  }
  const scoped = predicate ? `${change.table}, ${predicate}` : change.table;

  // Inserts and deletes are counted per table, not per row — see
  // `countCandidates`. Generating them here produced one `== 1` per row, so a
  // step that wrote two ledger legs offered the same wrong assertion twice.
  if (change.kind !== 'update') return out;

  // An update: one candidate per column that actually moved.
  for (const column of change.visibleColumns) {
    if (VOLATILE.test(column)) continue;
    const before = change.before?.[column];
    const after = change.after?.[column];
    if (!after) continue;
    // The hole this closes: the key guard above covered the *predicate*, and
    // this loop went on turning the column's own value into a literal. An
    // update to a masked column offered
    // `single(updated(cards, id = "c1")).after.card_number == "••••••••"` —
    // an assertion that is written into the scenario file, passes on every
    // later run whatever the real card number becomes, and proves nothing.
    const literal = literalOf(after, variables);
    if (literal === null) {
      withheld.push(`${change.table}.${column}`);
      continue;
    }

    if (
      NUMERIC.has(after.pgType) &&
      isVisible(before) &&
      isVisible(after) &&
      before.text != null &&
      after.text != null &&
      Decimal.isDecimal(before.text) &&
      Decimal.isDecimal(after.text)
    ) {
      // A delta survives a different starting balance; an absolute value does
      // not. For money that is almost always the assertion worth keeping.
      const delta = Decimal.parse(after.text).minus(Decimal.parse(before.text));
      out.push({
        expression: `delta(single(rows(${scoped})).${column}) == "${delta.toString()}"`,
        description: `${change.table}.${column} moves by ${delta.toString()} (${describeKey(change)})`,
        changeIndex: index,
      });
    }

    const shownAfter = displayText(after);
    out.push({
      expression: `single(updated(${scoped})).after.${column} == ${literal}`,
      description:
        isVisible(before) && before.text != null
          ? `${change.table}.${column} becomes ${shownAfter} (was ${displayText(before)})`
          : `${change.table}.${column} becomes ${shownAfter}`,
      changeIndex: index,
    });
  }

  if (out.length === 0) {
    // A write with nothing visible to assert on is itself the finding.
    out.push({
      expression: `hasWrite(changes(${scoped})) == true`,
      description: `${change.table} is written to without any value changing (${describeKey(change)})`,
      changeIndex: index,
      ...(countCaveat(detection, change.table) ? { caveat: countCaveat(detection, change.table)! } : {}),
    });
  }
  return out;
}

/**
 * Every assertion worth offering for one step.
 *
 * When nothing changed, the only candidate is the one that says so — and it is
 * often the most valuable assertion in a suite, because "the retry did nothing"
 * is exactly what an idempotency test is for.
 */
/**
 * What promotion produced, and what it declined to produce.
 *
 * `withheld` is not decoration. A run whose interesting columns are all masked
 * yields few candidates or none, and an empty list on its own reads as "there
 * was nothing worth asserting" rather than "this run cannot see the values".
 * That is the same mistake as an empty ChangeSet with no warning.
 */
export interface PromotedCandidates {
  readonly candidates: ReadonlyArray<AssertionCandidate>;
  /** `table.column` for each candidate not offered because the value is not available. */
  readonly withheld: ReadonlyArray<string>;
}

export function promoteCandidates(
  changes: ChangeSet,
  variables: Readonly<Record<string, string>>,
  responseStatus?: number,
): PromotedCandidates {
  const out: AssertionCandidate[] = [];
  const withheld: string[] = [];

  if (responseStatus !== undefined) {
    out.push({
      expression: `response.status == ${responseStatus}`,
      description: `the response is ${responseStatus}`,
      changeIndex: -1,
    });
  }

  if (changes.changes.length === 0) {
    out.push({
      expression: 'hasWrite(changes(*)) == false',
      description:
        changes.detection === 'write'
          ? 'nothing is written anywhere — not even a row rewritten with the same values'
          : 'no value changes anywhere (a write that changed nothing would not be caught)',
      changeIndex: -1,
      ...(changes.detection === 'write'
        ? {}
        : {
            caveat: {
              code: 'reduced-fidelity' as const,
              message:
                'This run used value detection, which cannot prove a write did not happen. ' +
                'The assertion will refuse to run rather than pass on a weaker basis.',
            },
          }),
    });
    return { candidates: out, withheld };
  }

  out.push(...countCandidates(withheld, changes, variables));
  changes.changes.forEach((change, index) => {
    out.push(...forChange(withheld, change, index, variables, changes.detection));
  });

  // Cross-row invariants are worth offering wherever a table's numeric column
  // moved in more than one row: a transfer that does not net to zero is the
  // classic ledger bug, and no single-row assertion catches it.
  const numericByTable = new Map<string, Set<string>>();
  for (const change of changes.changes) {
    if (change.kind !== 'update') continue;
    for (const column of change.visibleColumns) {
      if (VOLATILE.test(column)) continue;
      if (!NUMERIC.has(change.after?.[column]?.pgType ?? '')) continue;
      if (!numericByTable.has(change.table)) numericByTable.set(change.table, new Set());
      numericByTable.get(change.table)!.add(column);
    }
  }
  for (const [table, columns] of numericByTable) {
    const rows = changes.changes.filter((c) => c.table === table && c.kind === 'update');
    if (rows.length < 2) continue;
    for (const column of columns) {
      // All or nothing. A total summed over the rows that happened to be
      // readable, offered as a total over all of them, is the "books balance"
      // claim made about a subset — which is worse than not offering it.
      if (rows.some((c) => !isVisible(c.before?.[column]) || !isVisible(c.after?.[column]))) {
        withheld.push(`${table}.${column}`);
        continue;
      }
      const total = rows.reduce((acc, change) => {
        const before = (change.before?.[column] as VisibleValue | undefined)?.text;
        const after = (change.after?.[column] as VisibleValue | undefined)?.text;
        if (before == null || after == null || !Decimal.isDecimal(before) || !Decimal.isDecimal(after)) {
          return acc;
        }
        return acc.plus(Decimal.parse(after).minus(Decimal.parse(before)));
      }, Decimal.zero());
      out.push({
        expression: `sum(delta(${table}.${column})) == "${total.toString()}"`,
        description:
          total.isZero()
            ? `${table}.${column} nets to zero across all ${rows.length} rows — the books balance`
            : `${table}.${column} changes by ${total.toString()} in total across ${rows.length} rows`,
        changeIndex: -1,
      });
    }
  }

  // Last line of defence: two paths can arrive at the same expression, and an
  // offer list with repeats reads as a bug.
  const seen = new Set<string>();
  return {
    candidates: out.filter((candidate) => {
      if (seen.has(candidate.expression)) return false;
      seen.add(candidate.expression);
      return true;
    }),
    withheld: [...new Set(withheld)].sort(),
  };
}

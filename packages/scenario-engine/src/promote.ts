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

import type { AssertionCandidate, ChangeSet, RowChange, Value } from '@statescope/core';
import { Decimal } from '@statescope/expr';

/** Columns that are never worth asserting on: they differ every run by design. */
const VOLATILE = /^(created_at|updated_at|inserted_at|modified_at|touched|last_seen|version|etag)$/i;

const NUMERIC = new Set(['numeric', 'decimal', 'int2', 'int4', 'int8', 'float4', 'float8']);

/**
 * Renders a value for an expression, preferring a variable reference.
 *
 * Reversed lookup rather than forward substitution: we have the literal and
 * want to know whether the run already has a name for it.
 */
function literalOf(value: Value | undefined, variables: Readonly<Record<string, string>>): string {
  if (!value || value.text === null) return 'null';
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
  return change.key.columns
    .map(({ column, value }) => `${column} = ${literalOf(value, variables)}`)
    .join(' and ');
}

function describeKey(change: RowChange): string {
  if (!change.key) return `a row in ${change.table}`;
  return change.key.columns.map((c) => `${c.column} ${c.value.text ?? 'null'}`).join(', ');
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
        const values = new Set(rows.map((r) => r.after?.[column]?.text).filter((t) => t != null));
        for (const value of values) {
          const n = rows.filter((r) => r.after?.[column]?.text === value).length;
          const sample = rows.find((r) => r.after?.[column]?.text === value)!.after![column]!;
          out.push({
            expression: `count(inserted(${table}).where(${column} = ${literalOf(sample, variables)})) == ${n}`,
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
  change: RowChange,
  index: number,
  variables: Readonly<Record<string, string>>,
  detection: ChangeSet['detection'],
): AssertionCandidate[] {
  const out: AssertionCandidate[] = [];
  const predicate = predicateOf(change, variables);
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

    if (
      NUMERIC.has(after.pgType) &&
      before?.text != null &&
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

    out.push({
      expression: `single(updated(${scoped})).after.${column} == ${literalOf(after, variables)}`,
      description:
        before?.text != null
          ? `${change.table}.${column} becomes ${after.text} (was ${before.text})`
          : `${change.table}.${column} becomes ${after.text}`,
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
export function promoteCandidates(
  changes: ChangeSet,
  variables: Readonly<Record<string, string>>,
  responseStatus?: number,
): AssertionCandidate[] {
  const out: AssertionCandidate[] = [];

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
    return out;
  }

  out.push(...countCandidates(changes, variables));
  changes.changes.forEach((change, index) => {
    out.push(...forChange(change, index, variables, changes.detection));
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
      const total = rows.reduce((acc, change) => {
        const before = change.before?.[column]?.text;
        const after = change.after?.[column]?.text;
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
  return out.filter((candidate) => {
    if (seen.has(candidate.expression)) return false;
    seen.add(candidate.expression);
    return true;
  });
}

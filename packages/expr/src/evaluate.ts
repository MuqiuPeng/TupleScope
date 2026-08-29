/**
 * Evaluator for the selector language.
 *
 * Two rules shape everything here.
 *
 * The first is that an expression which cannot be *decided* must say so rather
 * than resolve to false. A mutation count evaluated against a value-comparing
 * ChangeSet, a `single()` that matched three rows, a table outside the watch
 * scope — each is `Unevaluable`, and the runner surfaces it as its own status.
 * A green run that could not have caught the failure is worse than no check.
 *
 * The second is that comparison happens under Postgres type semantics, never on
 * JS values: `numeric` compares as an exact decimal, `jsonb` structurally
 * (Postgres reorders object keys, so a string compare invents changes that did
 * not happen), `citext` case-insensitively.
 */

import type {
  ChangeSet,
  Detection,
  Expr,
  Mutation,
  RowChange,
  Selector,
  SelectorKind,
  Row,
  Temporal,
  RowsRead,
  Value,
  VisibleValue,
} from '@tuplescope/core';
import { displayText, visible } from '@tuplescope/core';
import { Decimal } from './decimal.js';

/** Raised when an expression cannot be decided. Never collapses into `false`. */
export class Unevaluable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Unevaluable';
  }
}

export interface EvalContext {
  changes: ChangeSet;
  response?: { status: number; headers: Record<string, string>; body: unknown };
  variables: Readonly<Record<string, string>>;
  /**
   * The rows a `rows(...)` selector asks for, as they are now.
   *
   * Supplied by the engine, which reads them through the adapter before
   * assertions run — so they inherit `maskColumns`, exactly like every other
   * value this tool reports.
   *
   * Its **absence is not a fallback**. `rows(...)` without it raises
   * `Unevaluable`: answering from the change set instead made `rows` a synonym
   * for `changes`, and `count(rows(t, pred)) == 0` passed over rows that were
   * plainly there.
   */
  lookupRows?: (table: string | undefined, predicate?: string) => RowsRead;
}

/**
 * What an expression evaluates to.
 *
 * Exported because a panel asks the same questions an assertion does and needs
 * the answer typed rather than flattened to a display string. `render()` is for
 * a human reading a failure message; anything drawing a value needs the `Value`
 * itself, which is the only thing that carries whether the run actually has it.
 */
export type EvalResult =
  | { kind: 'scalar'; value: string | number | boolean | null }
  /**
   * `partial` means rows are missing from this set, not that any value in it is
   * doubtful. Questions about the *set* — count, any, isEmpty, single, sum —
   * become unanswerable; questions about a row that is here stay decided.
   */
  | { kind: 'selection'; rows: ReadonlyArray<RowChange>; partial?: true }
  | { kind: 'column'; values: ReadonlyArray<Value | null>; temporal: Temporal };

// ─── Value semantics ──────────────────────────────────────────────────────────

const JSON_TYPES = new Set(['json', 'jsonb']);
const NUMERIC_TYPES = new Set(['numeric', 'decimal', 'int2', 'int4', 'int8', 'float4', 'float8']);

/** Deep structural equality, key order insensitive — what jsonb actually needs. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (typeof a !== 'object') return false;
  const ax = a as Record<string, unknown>;
  const bx = b as Record<string, unknown>;
  const keys = Object.keys(ax);
  if (keys.length !== Object.keys(bx).length) return false;
  return keys.every((k) => Object.hasOwn(bx, k) && jsonEqual(ax[k], bx[k]));
}

/**
 * Equality under the semantics of the type, for two values this run has.
 *
 * The signature is the guard. It takes `VisibleValue`, so a caller holding a
 * `Value` has to decide what a comparison against a withheld value means
 * *before* it gets here — and the answer is never a boolean. It used to take
 * `Value`, and a masked value compared on its placeholder: two masked values
 * came out equal to each other, and an assertion could be written against the
 * bullets and pass forever.
 */
export function valuesEqual(a: VisibleValue, b: VisibleValue): boolean {
  if (a.text === null || b.text === null) return a.text === b.text;
  const type = a.pgType || b.pgType;
  if (JSON_TYPES.has(type)) {
    try {
      return jsonEqual(JSON.parse(a.text), JSON.parse(b.text));
    } catch {
      return a.text === b.text;
    }
  }
  if (NUMERIC_TYPES.has(type) && Decimal.isDecimal(a.text) && Decimal.isDecimal(b.text)) {
    return Decimal.parse(a.text).equals(Decimal.parse(b.text));
  }
  if (type === 'citext') return a.text.toLowerCase() === b.text.toLowerCase();
  return a.text === b.text;
}

/**
 * Refuses anything this run does not have, before the caller can act on it.
 *
 * Named for the question rather than the value, because the message is the only
 * thing that survives: `Unevaluable` carries a string and no structured reason.
 */
function requireVisible(value: Value | null | undefined, what: string): VisibleValue {
  if (value === undefined || value === null) {
    throw new Unevaluable(`${what} was not read, so there is nothing to compare`);
  }
  if (value.state === 'masked') {
    throw new Unevaluable(
      `${what} is masked at capture, so this run does not have its value. ` +
        'Remove the column from `maskColumns` if the assertion needs it.',
    );
  }
  if (value.state === 'unknown') {
    throw new Unevaluable(`${what} could not be read (${value.reason}), so it cannot be compared`);
  }
  return value;
}

function asDecimal(value: Value | null, what: string): Decimal {
  // Before the NULL test, not after. Reaching `Decimal.isDecimal` with a
  // withheld value produced "is `••••••••`, which is not numeric" — which reads
  // as a type problem rather than a visibility one, and echoes the placeholder
  // back at the reader as though it were data.
  const seen = requireVisible(value, what);
  if (seen.text === null) throw new Unevaluable(`${what} is NULL, so it has no numeric value`);
  if (!Decimal.isDecimal(seen.text)) {
    throw new Unevaluable(`${what} is \`${seen.text}\`, which is not numeric`);
  }
  return Decimal.parse(seen.text);
}

// ─── Predicates ───────────────────────────────────────────────────────────────

/**
 * Matches `col = 'x'` clauses joined by `and`. Deliberately not SQL: predicates
 * exist to pick a row out of a handful of observed changes, and letting this
 * grow into a query language is how the assertion layer stops being auditable.
 */
/**
 * A predicate as column/value pairs, for a caller that has to turn it into SQL.
 *
 * Exported so the engine can build a **parameterised** `WHERE` rather than
 * interpolating the predicate text. The predicate comes from a scenario file
 * and can carry a captured variable's value; pasting it into a statement would
 * be an injection this tool has no business having.
 */
export function predicateClauses(
  predicate: string,
): Array<{ column: string; value: string | null }> {
  // Delegated, not duplicated. This used to carry its own copy of the clause
  // regex, so the two paths a predicate can take — matched against a captured
  // changeset, or turned into a `WHERE` against the live table — disagreed
  // about what a predicate means. `col = null` was a real NULL on one and the
  // four characters on the other, which is the shape of a bug nobody finds:
  // the same assertion answering differently depending on which selector it
  // was written with.
  return parsePredicate(predicate).map(({ column, literal }) => ({ column, value: literal }));
}

/** One `column = literal` test. `literal: null` is a real SQL NULL. */
export interface PredicateClause {
  readonly column: string;
  readonly literal: string | null;
  readonly source: string;
}

/**
 * Reads a predicate into clauses, refusing anything it cannot answer.
 *
 * The refusal has to happen here, and here has to be reachable without a row,
 * because `Array.prototype.filter` never calls its callback on an empty list.
 * While this lived only inside the per-row match, a predicate over a selection
 * that matched nothing was never read at all:
 *
 *     count(inserted(widgets).where(amount > 1000000)) == 0    → green, always
 *
 * That is exactly the shape of a must-not-write guard, so the assertion was
 * satisfied precisely when it was doing no work. `parse()` now calls this, so
 * an unsupported predicate is a syntax error at load time and `check` catches
 * it — the same treatment a misspelled table already got.
 *
 * Only `=` joined by `and` or a comma. `or`, `>`, `like` and the rest are
 * refused by name rather than mis-parsed: `kind = "A" or kind = "B"` used to
 * become one clause whose expected value was the seven characters
 * `A" or kind = "B`, which matched nothing and reported a green over two rows
 * that were right there. Widening the grammar is a separate decision from
 * closing this hole, and doing it in the other order would ship four new
 * operators over the same "never evaluated, therefore satisfied" floor.
 */
export function parsePredicate(predicate: string): PredicateClause[] {
  return splitClauses(predicate).map((clause) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=|<=|>=|<>|!=|<|>|~~\*?|\blike\b|\bilike\b|\bin\b|\bis\b)\s*(.+?)\s*$/i.exec(
      clause,
    );
    if (!m) throw new Unevaluable(`cannot read predicate \`${clause.trim()}\``);
    const [, column, operator, rawLiteral] = m;
    if (operator !== '=') {
      throw new Unevaluable(
        `\`${operator}\` is not available in a predicate — only \`=\`, joined by \`and\` or a comma. ` +
          `Select the rows with \`=\` and ask the rest with an aggregate.`,
      );
    }
    const bare = rawLiteral!.trim();
    // A bare, unquoted `null` is SQL's NULL. It used to be the four characters,
    // so `count(rows(t, col = null)) == 0` passed over a table with a real NULL
    // in it — answerable, wrongly, as a green.
    const literal = /^null$/i.test(bare) ? null : literalOf(bare, clause);
    return { column: column!, literal, source: clause.trim() };
  });
}

function matchesPredicate(row: Row | null, predicate: string): boolean {
  if (!row) return false;
  for (const { column, literal } of parsePredicate(predicate)) {
    const expected = literal;
    const actual = row[column];
    if (actual === undefined) throw new Unevaluable(`no column \`${column}\` to match on`);
    // Refused, not answered. A predicate is a question about a value, and
    // equality against a masked column is an oracle over it: ask enough of them
    // and the redaction is undone, one bit at a time, driven by a file that
    // came out of the repository.
    const seen = requireVisible(actual, `\`${column}\``);
    if (!valuesEqual(seen, visible(seen.pgType, expected))) return false;
  }
  return true;
}

/**
 * Splits a predicate into clauses on `and` or a comma, ignoring both inside a
 * quoted value.
 *
 * The comma matters. `rows(holds, account_id = "a", ref = "h")` is what anyone
 * writes for a composite key, and before this the whole tail parsed as a single
 * clause whose expected value was the literal `a", ref = "h` — so it matched
 * nothing, quietly, and `count(...) == 0` over a row that was really there came
 * back satisfied. Same family as an assertion about a misspelled table: the
 * selector found nothing, and finding nothing looked like proof.
 */
function splitClauses(predicate: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < predicate.length; i += 1) {
    const ch = predicate[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      out.push(predicate.slice(start, i));
      start = i + 1;
      continue;
    }
    const and = /^\s+and\s+/i.exec(predicate.slice(i));
    if (and) {
      out.push(predicate.slice(start, i));
      i += and[0].length - 1;
      start = i + 1;
      continue;
    }
    // Outside quotes, so `name = "Bob or Alice"` is untouched. An `or` reaching
    // here is a join this cannot evaluate, and guessing costs a wrong *answer*
    // rather than a wrong error: `kind = "A" or kind = "B"` used to survive as
    // one clause whose expected value was the fifteen characters
    // `A" or kind = "B`. It matched nothing, and written as `count(...) == 0`
    // it came back green with both rows printed directly above it.
    if (/^\s+or\s+/i.test(predicate.slice(i))) {
      throw new Unevaluable(
        '`or` is not available in a predicate — clauses join with `and` or a comma. ' +
          'Ask the two cases separately, or select more broadly and count.',
      );
    }
  }
  if (quote) throw new Unevaluable(`unterminated ${quote} in predicate \`${predicate}\``);
  out.push(predicate.slice(start));
  const clauses = out.filter((clause) => clause.trim().length > 0);
  if (clauses.length === 0) throw new Unevaluable('empty predicate');
  return clauses;
}

/**
 * Unwraps a predicate's right-hand side, refusing anything that is quoted but
 * not cleanly quoted. Stripping a stray quote and comparing the remains is how
 * a malformed predicate turns into a silent non-match.
 */
function literalOf(raw: string, clause: string): string {
  const text = raw.trim();
  const first = text[0];
  if (first === '"' || first === "'") {
    if (text.length >= 2 && text.endsWith(first)) return text.slice(1, -1);
    throw new Unevaluable(`cannot read predicate \`${clause.trim()}\`: the value is not closed`);
  }
  if (/['"]/.test(text)) {
    throw new Unevaluable(
      `cannot read predicate \`${clause.trim()}\`: the value contains a quote but does not start ` +
        `with one. Separate clauses with a comma or \`and\`.`,
    );
  }
  return text;
}

/**
 * The changed rows, plus the ones that exist and did not change.
 *
 * A row already in the change set keeps its real before-image; one that was
 * merely read has the same value on both sides, because that is what happened
 * to it. A `delta` over such a row is zero, which is true, rather than absent,
 * which would be a different claim.
 */
function union(changed: ReadonlyArray<RowChange>, current: ReadonlyArray<RowChange>): RowChange[] {
  // On the token, which is distinct per row whatever is redacted. The reported
  // key's text was the old join, and under a masked key column every row of the
  // table shared it — so two genuinely different rows deduped into one here.
  const seen = new Set(changed.map((c) => `${c.table}\u0000${c.key?.token ?? ''}`));
  return [...changed, ...current.filter((c) => !seen.has(`${c.table}\u0000${c.key?.token ?? ''}`))];
}

function rowFor(change: RowChange, temporal: Temporal): Row | null {
  return temporal === 'before' ? change.before : change.after;
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Refuses a question about *how* writes happened when the engine only recorded
 * *what* they ended up as.
 *
 * The same shape as `requireDetection`, for the same reason: the alternative is
 * to answer from a net view and be confidently wrong. `atomic(...)` over an
 * engine that never saw transaction boundaries would come back `true` for a
 * scenario that wrote through three separate transactions.
 */
function requireFidelity(changes: ChangeSet, what: string): ReadonlyArray<Mutation> {
  if (changes.fidelity !== 'transactional' || !changes.mutations) {
    throw new Unevaluable(
      `${what} needs the order writes happened in, but this run captured with ` +
        `\`${changes.captureMethod}\` (${changes.fidelity} fidelity). ` +
        `It recorded where each row ended up, not how it got there.`,
    );
  }
  return changes.mutations;
}

/**
 * The mutations that touched any of the selected rows, matched by table and
 * key.
 *
 * A selection is a set of rows, so a row the net view does not contain — one
 * inserted and deleted inside the same transaction — cannot be selected and so
 * is not counted here. It is still in `changes.mutations` and still shown by
 * the renderer; a selector simply is not the way to reach it.
 */
function mutationsFor(
  rows: ReadonlyArray<RowChange>,
  mutations: ReadonlyArray<Mutation>,
): Mutation[] {
  const wanted = new Set<string>();
  for (const row of rows) {
    if (row.key) wanted.add(`${row.table}\u0000${row.key.token}`);
  }
  return mutations.filter((m) => m.key !== null && wanted.has(`${m.table}\u0000${m.key.token}`));
}

function requireDetection(changes: ChangeSet, needed: Detection, what: string): void {
  if (needed === 'write' && changes.detection !== 'write') {
    throw new Unevaluable(
      `${what} needs write detection, but this run captured with ` +
        `\`${changes.captureMethod}\` (${changes.detection} detection). ` +
        `A value comparison cannot tell a redundant write from no write at all.`,
    );
  }
}

/**
 * Selector kinds whose count a value-detection engine can get wrong.
 *
 * The distinction is what a value comparison can and cannot see:
 *
 *   inserted / deleted   a row is there or it is not. Presence is a value-level
 *                        fact, so both detections count these exactly.
 *   rows                 current state, read directly. Nothing to miss.
 *   updated / changes    a row rewritten to the same values is a change under
 *                        write detection and invisible under value detection,
 *                        so the count is a floor rather than an answer.
 *
 * Counting the second group against a value-detection engine is unevaluable,
 * and specifically not `0` — returning a number that is merely a lower bound
 * with no sign that it is one is how an idempotency check passes over a real
 * duplicate write.
 *
 * This asks what the engine *can do*, never which engine it is. An engine that
 * cannot be placed by `detection` is a signal that ChangeSet is missing an
 * axis, not that this list should learn another name.
 */
const UNDERCOUNTED_UNDER_VALUE_DETECTION: ReadonlySet<SelectorKind> = new Set(['updated', 'changes']);

/**
 * Raises `Unevaluable` when an emptiness or count question is being asked of an
 * engine that could answer it wrongly.
 *
 * `count`, `any` and `isEmpty` all reduce a selection to a claim about whether
 * anything happened, so they all need the same guard. Left ungrounded, the
 * dangerous direction is the confident one: `isEmpty(changes(*)) == true` over
 * a value-detection engine reads as "nothing was written" when what actually
 * happened may have been a rewrite to identical values — an idempotency check
 * passing over exactly the bug it was written to catch.
 */
function guardSelectionQuestion(expr: Expr, changes: ChangeSet, what: string): void {
  const kinds = [...selectorKinds(expr)].filter((k) => UNDERCOUNTED_UNDER_VALUE_DETECTION.has(k));
  if (kinds.length === 0) return;
  requireDetection(changes, 'write', `${what} over ${kinds.sort().join(' and ')}`);
}

/** Every selector kind feeding an expression, so a count knows what it is counting. */
function selectorKinds(expr: Expr, into: Set<SelectorKind> = new Set()): Set<SelectorKind> {
  switch (expr.node) {
    case 'select':
      into.add(expr.selector.kind);
      break;
    case 'column':
    case 'aggregate':
    case 'predicate':
    case 'hasWrite':
    case 'isEmpty':
    case 'atomic':
    case 'writeCount':
      selectorKinds(expr.source, into);
      break;
    case 'compare':
      selectorKinds(expr.left, into);
      selectorKinds(expr.right, into);
      break;
    default:
      break;
  }
  return into;
}

function evaluate(expr: Expr, ctx: EvalContext): EvalResult {
  switch (expr.node) {
    case 'literal':
      return { kind: 'scalar', value: expr.value };

    case 'variable': {
      const value = ctx.variables[expr.name];
      if (value === undefined) throw new Unevaluable(`no variable \`${expr.name}\` was captured`);
      return { kind: 'scalar', value };
    }

    case 'response': {
      if (!ctx.response) throw new Unevaluable('this step has no response to read');
      if (expr.path === 'status') return { kind: 'scalar', value: ctx.response.status };
      const [head, ...rest] = expr.path.split('.');
      let cursor: unknown =
        head === 'body' ? ctx.response.body : head === 'headers' ? ctx.response.headers : undefined;
      if (cursor === undefined) throw new Unevaluable(`cannot read \`response.${expr.path}\``);
      for (const key of rest) {
        if (cursor === null || typeof cursor !== 'object') {
          throw new Unevaluable(`\`response.${expr.path}\` stops at \`${key}\``);
        }
        cursor = (cursor as Record<string, unknown>)[key];
      }
      if (cursor === undefined) return { kind: 'scalar', value: null };
      return {
        kind: 'scalar',
        value:
          typeof cursor === 'object' ? JSON.stringify(cursor) : (cursor as string | number | boolean),
      };
    }

    case 'select': {
      const { kind, table, predicate, exceptTables } = expr.selector;
      // `changes(* except a, b)`. Every excluded name is resolved first: an
      // exclusion that names nothing removes nothing, so the assertion silently
      // widens to cover a table the author believed they had carved out — which
      // is the failure this form exists to prevent, arriving through the form
      // itself.
      for (const excluded of exceptTables ?? []) {
        if (inScope(ctx.changes, excluded)) continue;
        const known = knownTables(ctx.changes);
        const near = known.find((t) => close(t, excluded));
        throw new Unevaluable(
          `\`except\` names \`${excluded}\`, which is not being watched, so it excludes nothing` +
            (near ? ` — did you mean \`${near}\`?` : ` (watched: ${known.join(', ') || 'none'})`),
        );
      }
      if (table && !inScope(ctx.changes, table)) {
        const known = knownTables(ctx.changes);
        const near = known.find((t) => close(t, table));
        throw new Unevaluable(
          ctx.changes.scope.allTables
            ? `there is no table \`${table}\` in this database` +
              (near ? ` — did you mean \`${near}\`?` : ` (tables: ${known.join(', ') || 'none'})`)
            : `table \`${table}\` is not being watched, so nothing can be asserted about it` +
              (near ? ` — did you mean \`${near}\`?` : ''),
        );
      }
      const excluded = new Set(exceptTables ?? []);
      let rows = ctx.changes.changes.filter(
        (c) => (!table || c.table === table) && !excluded.has(c.table),
      );
      if (kind === 'inserted') rows = rows.filter((c) => c.kind === 'insert' || c.kind === 'entered-scope');
      else if (kind === 'updated') rows = rows.filter((c) => c.kind === 'update');
      else if (kind === 'deleted') rows = rows.filter((c) => c.kind === 'delete' || c.kind === 'left-scope');
      if (predicate) {
        rows = rows.filter((c) => matchesPredicate(c.after ?? c.before, predicate));
      }

      if (kind === 'rows') {
        // `rows(...)` means "matching rows, whether or not they changed", and
        // answering it from the change set alone makes it a synonym for
        // `changes(...)`. It was one, and the consequence was a forbidden
        // green: `count(rows(wallets, id = "wal_alice")) == 0` passed over a
        // wallet that plainly exists, because it had not been written.
        if (!ctx.lookupRows) {
          throw new Unevaluable(
            `rows(${table ?? '*'}) reads the rows as they are now, and this run has no way to ` +
              `read them — only what changed. Use \`changes(${table ?? '*'})\`, ` +
              `\`inserted(...)\` or \`updated(...)\` to ask about the change itself.`,
          );
        }
        const read = ctx.lookupRows(table, predicate);
        rows = union(rows, read.rows);
        if (!read.complete) {
          return {
            kind: 'selection',
            rows,
            partial: true,
          };
        }
      }
      return { kind: 'selection', rows };
    }

    case 'predicate': {
      const evaluated = evaluate(expr.source, ctx);
      const source = asSelection(evaluated, 'where');
      // Narrowing a partial set does not complete it: the rows that were never
      // read might have matched too.
      const partial = evaluated.kind === 'selection' && evaluated.partial;
      return {
        kind: 'selection',
        rows: source.filter((c) => matchesPredicate(c.after ?? c.before, expr.predicate)),
        ...(partial ? { partial: true as const } : {}),
      };
    }

    case 'column': {
      if (expr.temporal === null) {
        throw new Unevaluable(
          `\`${expr.column}\` needs a side: write .before.${expr.column}, ` +
            `.after.${expr.column}, or delta(...${expr.column}).`,
        );
      }
      const rows = asSelection(evaluate(expr.source, ctx), 'a column read');
      if (expr.temporal === 'delta') {
        const values = rows.map((change) => {
          const before = change.before?.[expr.column] ?? null;
          const after = change.after?.[expr.column] ?? null;
          const zero = Decimal.zero();
          const from = before ? asDecimal(before, `${change.table}.${expr.column} before`) : zero;
          const to = after ? asDecimal(after, `${change.table}.${expr.column} after`) : zero;
          const pgType = after?.pgType ?? before?.pgType ?? 'numeric';
          // `asDecimal` above already refused anything not visible, so a delta
          // is only ever computed from two values this run actually has. It
          // never falls back to zero, which would be the claim "nothing moved".
          return visible(pgType, to.minus(from).toString());
        });
        return { kind: 'column', values, temporal: 'delta' };
      }
      const values = rows.map((change) => rowFor(change, expr.temporal!)?.[expr.column] ?? null);
      return { kind: 'column', values, temporal: expr.temporal };
    }

    case 'aggregate': {
      const source = evaluate(expr.source, ctx);
      switch (expr.fn) {
        case 'count': {
          const rows = asSelection(source, 'count');
          requireWholeSet(source, 'count()');
          guardSelectionQuestion(expr.source, ctx.changes, 'counting');
          return { kind: 'scalar', value: rows.length };
        }
        case 'single': {
          const rows = asSelection(source, 'single');
          requireWholeSet(source, 'single()');
          if (rows.length !== 1) {
            throw new Unevaluable(
              `single() expected exactly one row, found ${rows.length}. ` +
                `Narrow it with a predicate, or use count()/sum() if many rows are intended.`,
            );
          }
          return { kind: 'selection', rows };
        }
        case 'sum': {
          requireWholeSet(source, 'sum()');
          const column = asColumn(source, 'sum');
          const total = column.values.reduce<Decimal>(
            (acc, v, i) => acc.plus(asDecimal(v, `value ${i}`)),
            Decimal.zero(),
          );
          return { kind: 'scalar', value: total.toString() };
        }
        case 'min':
        case 'max': {
          requireWholeSet(source, `${expr.fn}()`);
          const column = asColumn(source, expr.fn);
          if (column.values.length === 0) throw new Unevaluable(`${expr.fn}() over an empty set`);
          const decimals = column.values.map((v, i) => asDecimal(v, `value ${i}`));
          const pick = decimals.reduce((a, b) =>
            (expr.fn === 'min' ? a.compare(b) <= 0 : a.compare(b) >= 0) ? a : b,
          );
          return { kind: 'scalar', value: pick.toString() };
        }
        case 'any': {
          const rows = asSelection(source, 'any');
          requireWholeSet(source, 'any()');
          guardSelectionQuestion(expr.source, ctx.changes, 'any()');
          return { kind: 'scalar', value: rows.length > 0 };
        }
      }
      break;
    }

    case 'hasWrite': {
      const rows = asSelection(evaluate(expr.source, ctx), 'hasWrite');
      requireDetection(ctx.changes, 'write', 'hasWrite');
      return { kind: 'scalar', value: rows.some((c) => c.hasWrite) };
    }

    case 'isEmpty': {
      const evaluated = evaluate(expr.source, ctx);
      const rows = asSelection(evaluated, 'isEmpty');
      requireWholeSet(evaluated, 'isEmpty()');
      guardSelectionQuestion(expr.source, ctx.changes, 'isEmpty()');
      return { kind: 'scalar', value: rows.length === 0 };
    }

    case 'writeCount': {
      const rows = asSelection(evaluate(expr.source, ctx), 'writeCount');
      const all = requireFidelity(ctx.changes, 'writeCount()');
      return { kind: 'scalar', value: mutationsFor(rows, all).length };
    }

    case 'atomic': {
      const rows = asSelection(evaluate(expr.source, ctx), 'atomic');
      const all = requireFidelity(ctx.changes, 'atomic()');
      const touching = mutationsFor(rows, all);
      if (touching.length === 0) {
        // Nothing was written, so there is nothing that was or was not atomic.
        // Answering `true` here would be a vacuous pass over an empty set —
        // the same shape as an assertion about a table that does not exist.
        throw new Unevaluable(
          'atomic() over rows that were never written; there is no grouping to check',
        );
      }
      const transactions = new Set(touching.map((m) => m.transactionId));
      // An engine that reports transactional fidelity but cannot name the
      // transaction has not answered the question either.
      if (transactions.has(null)) {
        throw new Unevaluable('atomic() needs transaction ids, and this run has writes without one');
      }
      return { kind: 'scalar', value: transactions.size === 1 };
    }

    case 'not': {
      const inner = evaluate(expr.operand, ctx);
      return { kind: 'scalar', value: !truthy(inner) };
    }

    case 'logical': {
      const left = truthy(evaluate(expr.left, ctx));
      if (expr.op === 'and' && !left) return { kind: 'scalar', value: false };
      if (expr.op === 'or' && left) return { kind: 'scalar', value: true };
      return { kind: 'scalar', value: truthy(evaluate(expr.right, ctx)) };
    }

    case 'compare':
      return { kind: 'scalar', value: compare(expr.op, evaluate(expr.left, ctx), evaluate(expr.right, ctx)) };
  }
  throw new Unevaluable('unsupported expression');
}

/**
 * Whether a name in an expression is a table this run actually observed.
 *
 * Membership is checked even when the scope covers every table, because
 * `allTables` says the *scope* was not narrowed — it says nothing about whether
 * the name in the assertion is real. Short-circuiting on it meant a typo passed
 * straight through: `count(inserted(paymnets)) == 0` selected from a table that
 * does not exist, found nothing, and reported a green. A misspelled table name
 * silently satisfying an assertion is the exact failure this product is for.
 *
 * `scope.tables` is populated with every table in either mode, so the check
 * costs nothing; `allTables` now only decides which of the two errors to raise.
 */
function inScope(changes: ChangeSet, table: string): boolean {
  return changes.scope.tables.some((t) => t.table === table);
}

/**
 * Within one Damerau edit of each other, ignoring case — enough to name a typo.
 *
 * Damerau rather than plain Levenshtein because a transposition is the most
 * common typing mistake there is, and `paymnets` for `payments` costs two
 * substitutions under Levenshtein: exactly the case the suggester exists for
 * would be the one it missed.
 *
 * Rejecting the name is what keeps the run honest; naming the intended one is
 * what turns the refusal into a fix.
 */
function close(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;

  if (x.length === y.length) {
    const differing: number[] = [];
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) {
        differing.push(i);
        if (differing.length > 2) return false;
      }
    }
    if (differing.length === 1) return true; // one substitution
    // Two differences adjacent and mirrored is one transposition.
    const [i, j] = differing as [number, number];
    return j === i + 1 && x[i] === y[j] && x[j] === y[i];
  }

  if (Math.abs(x.length - y.length) !== 1) return false;
  const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
  let i = 0;
  let skipped = false;
  for (let j = 0; j < longer.length; j++) {
    if (shorter[i] === longer[j]) {
      i++;
      continue;
    }
    if (skipped) return false;
    skipped = true; // one insertion in the longer string
  }
  return i === shorter.length;
}

/** The tables this run could have said anything about, for an error message. */
function knownTables(changes: ChangeSet): string[] {
  return changes.scope.tables.map((t) => t.table).sort();
}

function asSelection(value: EvalResult, what: string): ReadonlyArray<RowChange> {
  if (value.kind !== 'selection') throw new Unevaluable(`${what} needs a set of rows`);
  return value.rows;
}

/**
 * A question about the *set*, over a set that is missing rows.
 *
 * Refused rather than answered from what was read. `count()` over a truncated
 * read is a lower bound presented as a total — measured on a 1200-row table,
 * `count(rows(events))` answered 500 — and every one of these has the same
 * shape. The rows that *were* read stay perfectly usable: an assertion about
 * one of them is still decided, which is why this guard is here and not on the
 * values.
 */
function requireWholeSet(value: EvalResult, what: string): void {
  if (value.kind === 'selection' && value.partial) {
    throw new Unevaluable(
      `${what} needs the whole set, and this read stopped at its limit — there are rows it did ` +
        'not see. Narrow the selector with a predicate so it names the rows you mean.',
    );
  }
}

function asColumn(value: EvalResult, what: string): Extract<EvalResult, { kind: 'column' }> {
  if (value.kind !== 'column') throw new Unevaluable(`${what} needs a column, e.g. ${what}(wallets.balance)`);
  return value;
}

function truthy(value: EvalResult): boolean {
  if (value.kind === 'selection') return value.rows.length > 0;
  if (value.kind === 'column') return value.values.length > 0;
  return value.value === true;
}

/** Renders any evaluated result for display in a failure message. */
export function render(value: EvalResult): string {
  if (value.kind === 'scalar') return value.value === null ? 'null' : String(value.value);
  if (value.kind === 'selection') return `${value.rows.length} row(s)`;
  if (value.values.length === 1) return displayText(value.values[0] ?? undefined);
  return `[${value.values.map((v) => displayText(v ?? undefined)).join(', ')}]`;
}

function compare(op: string, left: EvalResult, right: EvalResult): boolean {
  const a = coerce(left);
  const b = coerce(right);
  if (op === '==' || op === '!=') {
    // Both sides refused *before* the negation. A guard applied after it turns
    // "cannot tell" into `true` for every `!=` in a suite — which goes green
    // precisely because the evaluator can see nothing.
    const equal = valuesEqual(
      requireVisible(a, 'left side'),
      requireVisible(b, 'right side'),
    );
    return op === '==' ? equal : !equal;
  }
  const order = asDecimal(a, 'left side').compare(asDecimal(b, 'right side'));
  switch (op) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
  }
  throw new Unevaluable(`unknown operator \`${op}\``);
}

/** Reduces an evaluated result to the single value a comparison can use. */
function coerce(value: EvalResult): Value {
  if (value.kind === 'scalar') {
    if (value.value === null) return visible('text', null);
    if (typeof value.value === 'number') return visible('numeric', String(value.value));
    if (typeof value.value === 'boolean') return visible('bool', String(value.value));
    return visible(Decimal.isDecimal(value.value) ? 'numeric' : 'text', value.value);
  }
  if (value.kind === 'column') {
    if (value.values.length !== 1) {
      throw new Unevaluable(
        `comparison needs one value, got ${value.values.length}. ` +
          `Wrap it in single(...) or sum(...).`,
      );
    }
    return value.values[0] ?? visible('text', null);
  }
  throw new Unevaluable('cannot compare a set of rows directly — use count() or single()');
}

/**
 * Entry point: evaluates a parsed expression to true/false.
 *
 * On a comparison, `actual` reports the left-hand side rather than the verdict.
 * "expected 1, got 2" tells you what to fix; "got false" makes you re-run the
 * query by hand to find out what happened, which is the failure mode this whole
 * tool exists to remove.
 */
export function evaluateAssertion(
  expr: Expr,
  ctx: EvalContext,
): { passed: boolean; actual: string; expected?: string } {
  const result = evaluate(expr, ctx);
  const passed = truthy(result);
  if (expr.node === 'compare' && !passed) {
    return {
      passed,
      actual: render(evaluate(expr.left, ctx)),
      expected: render(evaluate(expr.right, ctx)),
    };
  }
  return { passed, actual: render(result) };
}

export { evaluate as evaluateExpr };

/**
 * Every `rows(...)` selector an expression contains.
 *
 * The engine needs these *before* it evaluates, because reading rows is
 * asynchronous and evaluation is not. Walking the parsed expression is what
 * makes the pre-fetch exact: one query per selector the assertion actually
 * asks for, rather than a guess at which tables might be wanted.
 */
export function rowsSelectorsIn(expr: Expr, into: Selector[] = []): Selector[] {
  switch (expr.node) {
    case 'select':
      if (expr.selector.kind === 'rows') into.push(expr.selector);
      break;
    case 'column':
    case 'aggregate':
    case 'predicate':
    case 'hasWrite':
    case 'isEmpty':
    case 'atomic':
    case 'writeCount':
      rowsSelectorsIn(expr.source, into);
      break;
    case 'compare':
      rowsSelectorsIn(expr.left, into);
      rowsSelectorsIn(expr.right, into);
      break;
    case 'not':
      rowsSelectorsIn(expr.operand, into);
      break;
    default:
      break;
  }
  return into;
}

/**
 * Every `table.column` a predicate names, for `check` to resolve before a run.
 *
 * The column names in `.where(...)` and in `rows(t, ...)` are read at
 * evaluation time by `matchesPredicate`, and only when there is a row to read
 * them against. `Array.prototype.filter` never calls its callback on an empty
 * list, so a step that wrote nothing never resolves them at all:
 *
 *     count(inserted(widgets).where(nmae = "x")) == 0     → green, always
 *
 * The value is not wrong — nothing was inserted, so nothing matched. It is
 * unfalsifiable, and it is unfalsifiable in exactly the shape of a "this must
 * not write twice" guard, which is the assertion this tool exists to make. A
 * typo there is a permanent pass on the thing being tested.
 *
 * Runtime cannot decide it: the answer really is zero, and refusing would turn
 * every correct no-write assertion undecided. `check` can, because it holds a
 * connection and the schema. Same family as the misspelled *table* it already
 * catches, and the same reason: finding nothing is not proof.
 *
 * Returns pairs, because a column is only meaningful against its table.
 * Predicates on a table-less selector (`changes(*)`) are skipped — there is no
 * one table to resolve them against.
 */
export function predicateColumnsIn(expr: Expr): Array<{ table: string; column: string }> {
  const found: Array<{ table: string; column: string }> = [];

  /** The nearest table underneath a `.where(...)`, or undefined for `changes(*)`. */
  const tableOf = (node: Expr): string | undefined => {
    switch (node.node) {
      case 'select':
        return node.selector.table;
      case 'predicate':
      case 'column':
      case 'aggregate':
      case 'hasWrite':
      case 'isEmpty':
      case 'atomic':
      case 'writeCount':
        return tableOf(node.source);
      default:
        return undefined;
    }
  };

  const columnsOf = (predicate: string): string[] =>
    splitClauses(predicate)
      .map((clause) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(clause)?.[1])
      .filter((name): name is string => name !== undefined);

  const walk = (node: Expr): void => {
    switch (node.node) {
      case 'select': {
        const { table, predicate } = node.selector;
        if (table && predicate) for (const column of columnsOf(predicate)) found.push({ table, column });
        return;
      }
      case 'predicate': {
        const table = tableOf(node.source);
        if (table) for (const column of columnsOf(node.predicate)) found.push({ table, column });
        walk(node.source);
        return;
      }
      case 'column':
      case 'aggregate':
      case 'hasWrite':
      case 'isEmpty':
      case 'atomic':
      case 'writeCount':
        walk(node.source);
        return;
      case 'compare':
      case 'logical':
        walk(node.left);
        walk(node.right);
        return;
      case 'not':
        walk(node.operand);
        return;
      default:
        return;
    }
  };

  walk(expr);
  return found;
}

/**
 * Every table an `except` list names, for `check` to resolve before a run.
 *
 * `tablesNamedIn` in the CLI is a regex over a selector's first argument, and
 * `changes(* except a, b)` puts `*` there — so the excluded names were
 * invisible to it. An exclusion that names nothing excludes nothing, which
 * quietly widens the assertion to cover a table the author believed they had
 * carved out. The evaluator refuses it at runtime; catching it before the run
 * is the same courtesy a misspelled table already gets.
 */
export function exceptedTablesIn(expr: Expr): string[] {
  const found: string[] = [];
  const walk = (node: Expr): void => {
    switch (node.node) {
      case 'select':
        found.push(...(node.selector.exceptTables ?? []));
        return;
      case 'predicate':
      case 'column':
      case 'aggregate':
      case 'hasWrite':
      case 'isEmpty':
      case 'atomic':
      case 'writeCount':
        walk(node.source);
        return;
      case 'compare':
      case 'logical':
        walk(node.left);
        walk(node.right);
        return;
      case 'not':
        walk(node.operand);
        return;
      default:
        return;
    }
  };
  walk(expr);
  return found;
}

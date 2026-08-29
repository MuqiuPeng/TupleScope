/**
 * The selector language.
 *
 * This is a contract, not a convenience. The same expressions that appear in
 * `assert:` in v0.1 are what a declarative dashboard's `source:` will evaluate
 * in v0.2, so the plugin API is already frozen the moment the first assertion
 * ships — whether or not anyone calls it that. One evaluator serves both.
 *
 * The shorthand it replaces was ambiguous in ways that matter:
 *
 *   payments.status == REFUNDED     which row? what if two changed? before or after?
 *   wallets.balance.delta == 100    a transfer moves two wallets, +100 and -100
 *
 * So selection is explicit, aggregation is explicit, and the temporal side —
 * before, after, or the difference — is always stated.
 */

import type { Detection } from './changeset.js';

/**
 * Which rows an expression is talking about.
 *
 * `changes` is every touched row; the others filter by kind. Each may carry a
 * predicate (`inserted(transactions).where(type = 'REVERSAL')`) and each is
 * scoped to a table unless the expression is deliberately schema-wide.
 */
export type SelectorKind =
  | 'changes'
  | 'inserted'
  | 'updated'
  | 'deleted'
  /** Rows matching a key, whether or not they changed. Reads current state. */
  | 'rows';

export interface Selector {
  kind: SelectorKind;
  /** Omitted for schema-wide forms such as `changes(*)`. */
  table?: string;
  /** `id = {{payment_id}}`, `type = 'REVERSAL'`. Templated before evaluation. */
  predicate?: string;
  /** Restricts to one step's changes; defaults to the step being evaluated. */
  step?: string;
}

/** Which side of the change a column is read from. Never implicit. */
export type Temporal = 'before' | 'after' | 'delta';

/**
 * Reducers over a selected set.
 *
 * `single` is the one to reach for by default: it asserts that exactly one row
 * matched and fails otherwise, which is almost always the intent and is what
 * the old shorthand silently guessed at.
 */
/**
 * `all` was here and is gone. It parsed, `check` blessed the assertion, and the
 * evaluator answered `undecided — all() is not available yet` — poisoning the
 * whole run to exit 3 over a form that could never do anything else. A grammar
 * that accepts what nothing can evaluate is the same promise-without-evidence
 * this contract exists to refuse; an unknown name is now a syntax error naming
 * the forms that do exist.
 */
export type Aggregate = 'single' | 'count' | 'sum' | 'min' | 'max' | 'any';

export type Expr =
  | { node: 'literal'; value: string | number | boolean | null }
  /** `response.status`, `response.body.id`, `response.headers.location`. */
  | { node: 'response'; path: string }
  /** A captured or built-in variable. */
  | { node: 'variable'; name: string }
  | { node: 'select'; selector: Selector }
  /**
   * Reads a column off a selected set.
   *
   * `temporal` is `null` until something supplies it — either an explicit
   * `.after.status`, or a `delta(...)` / `before(...)` / `after(...)` wrapper.
   * A column that reaches evaluation still unresolved is an error rather than a
   * guess, because "the status" meaning before or after is the whole question.
   */
  | { node: 'column'; source: Expr; column: string; temporal: Temporal | null }
  | { node: 'aggregate'; fn: Aggregate; source: Expr }
  | { node: 'predicate'; source: Expr; predicate: string }
  /**
   * True when anything wrote to the selected rows, regardless of whether values
   * changed or whether the changed columns were ignored. The primitive
   * idempotency assertions are built on — see `hasWrite` in `changeset.ts`.
   */
  | { node: 'hasWrite'; source: Expr }
  | { node: 'isEmpty'; source: Expr }
  /**
   * True when every write to the selected rows happened inside one database
   * transaction — the question "did my API do this atomically?", which nothing
   * else here can ask. Needs an engine that kept the grouping; against one that
   * did not it is `unevaluable`, never `false`.
   */
  | { node: 'atomic'; source: Expr }
  /**
   * How many times the selected rows were written, which is not how many rows
   * changed. A balance moved `100 → 80 → 100` inside one request is one changed
   * row and two writes, and only the second number shows the retry.
   */
  | { node: 'writeCount'; source: Expr }
  | { node: 'compare'; op: CompareOp; left: Expr; right: Expr }
  | { node: 'logical'; op: 'and' | 'or'; left: Expr; right: Expr }
  | { node: 'not'; operand: Expr };

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

/**
 * What an expression needs from the engine in order to mean anything.
 *
 * Computed at parse time so a scenario can be rejected before it runs rather
 * than producing a green result the engine was never able to verify.
 */
export interface ExprRequirements {
  /**
   * `write` for anything reading `hasWrite` or counting mutations. Running such
   * an expression against a `value`-detection ChangeSet is an error, not a
   * degraded pass.
   */
  detection: Detection;
  /** Tables the expression reads. Any of these outside the watch scope is a config error. */
  tables: ReadonlyArray<string>;
}

export type AssertionStatus =
  | 'passed'
  | 'failed'
  /** Expected-and-received rejection: a pass, rendered amber rather than green. */
  | 'passed-as-refused'
  /** Could not be evaluated — wrong detection mode, table outside scope, bad expression. */
  | 'unevaluable';

export interface AssertionResult {
  /** The expression as the user wrote it, before templating. */
  source: string;
  status: AssertionStatus;
  /** Rendered actual value, e.g. `-100.00`. */
  actual?: string;
  expected?: string;
  /**
   * Why an `unevaluable` result could not be decided. Never collapsed into a
   * failure: "this could not be checked" and "this was checked and is wrong"
   * lead to different actions.
   */
  reason?: string;
}

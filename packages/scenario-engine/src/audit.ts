/**
 * What a suite can prove, decided without sending a request.
 *
 * One implementation, because there were two and they drifted. `tuplescope
 * check` and the MCP `check_scenarios` described themselves almost identically
 * and did different work: the MCP copy destructured only `tables` from
 * preflight, so it validated no predicate columns and no `except` names, and it
 * blessed a selection of zero scenarios that the CLI refuses. An agent calling
 * the weaker one was told a suite was sound when the CLI would have said it was
 * not.
 *
 * Every check here exists because the thing it catches otherwise stays green
 * forever rather than failing loudly:
 *
 * - a **table** an assertion names that the database does not have — an
 *   assertion about a table that does not exist finds nothing, and `count(...)
 *   == 0` over nothing passes;
 * - a **predicate column** that is misspelled — the evaluator resolves those
 *   only when it has a row to resolve them against, and a step that writes
 *   nothing never gives it one, which is exactly the shape of a "must not write
 *   twice" guard;
 * - a **column read as a value** that its table does not have —
 *   `single(updated(wallets)).after.balanse` reads nothing, and a `delta` of
 *   nothing on either side is zero, so `sum(delta(wallets.balanse)) == "0.00"`
 *   passes over any movement of the real column. Resolved against the table the
 *   syntax tree names; under `changes(*)` there is no one table to resolve it
 *   against, so it is skipped, exactly as a predicate column is;
 * - an **`except`** that names nothing, which therefore excludes nothing and
 *   silently widens the assertion it was written to narrow;
 * - a **step with no assertions**, which will be observed and verified by no
 *   one.
 *
 * And the assertions no run can decide, for a reason that is not the system
 * under test — each reported in the words the run uses to refuse it, once per
 * assertion, because `check`'s clean sentence over them was a promise every run
 * then broke:
 *
 * - a question the **capture engine** cannot answer — `atomic` and
 *   `writeCount` under net fidelity, `hasWrite` and counting `updated` or
 *   `changes` under value detection. Asked of `detection` and `fidelity`,
 *   never of the engine's name (packages/core/src/abstraction.test.ts);
 * - a **masked column** matched on or read — masking happens at capture, so no
 *   run has the value, and `requireVisible` refuses it;
 * - a table with **no row identity** under a question about rows leaving it —
 *   where the engine cannot see a row leave a table with no primary key and no
 *   unique index, `guardRowIdentity` refuses `updated` or `deleted` of that
 *   table, and a question about every watched table that does not `except` it;
 * - a **reference** — `${secret:…}`, `${VAR}` — in a request: scenario files
 *   resolve only `{{name}}`, so the run refuses the step rather than send those
 *   characters. `$${` is the escape, sent as `${`, and is not reported.
 *
 * Names are resolved from the syntax tree, not by pattern-matching the source.
 * The regex both callers used could only see an identifier in a selector's first
 * argument, so the bare-table shorthand — `sum(delta(wallets.balance))`, which
 * is what `promote` generates — carried a misspelling straight past the command
 * whose only job is catching them.
 */

import {
  exceptedTablesIn,
  parse,
  parsePredicate,
  predicateColumnsIn,
  tablesNamedIn,
} from '@tuplescope/expr';
import type {
  Dataset,
  Detection,
  Expr,
  Fidelity,
  Scenario,
  Selector,
  SelectorKind,
} from '@tuplescope/core';
import {
  describeReference,
  INSTEAD_OF_A_REFERENCE,
  referencesIn,
  SECRET_REFERENCE,
} from './references.js';

/** One dataset of one scenario, as the callers already hold them. */
export interface AuditTarget {
  readonly scenario: Scenario;
  readonly dataset: Dataset;
}

export interface AuditSchema {
  /** Table names the database actually has, in the watched schema. */
  readonly tables: ReadonlySet<string>;
  /** Column names per table, for resolving predicates. */
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * What the workspace's capture engine can do. When absent, the questions an
   * engine may be unable to answer are not checked.
   */
  readonly capture?: { detection: Detection; fidelity: Fidelity };
  /**
   * The workspace's `maskColumns`. A scenario's own `maskColumns` is added to
   * it, as the capture scope adds it. When absent, masking is not checked.
   */
  readonly maskColumns?: ReadonlyArray<string>;
  /**
   * Tables in which a run cannot see a row leave: the ones the capture scope
   * marks `departuresObservable: false`, which is what the evaluator reads. On
   * the MVCC engines that is every table with no primary key and no unique
   * index. An engine that re-reads the table sees a row leave, and marks none.
   * A scenario's `watch` list is applied here, as the capture scope applies
   * it. When absent, row identity is not checked.
   */
  readonly keyless?: ReadonlySet<string>;
}

export interface AuditProblem {
  readonly scenarioId: string;
  readonly datasetId: string;
  readonly stepId: string;
  /** What is wrong, as a sentence, without the location prefix. */
  readonly message: string;
}

export interface AuditResult {
  readonly problems: ReadonlyArray<AuditProblem>;
  /** Assertions across the selection, so a caller can refuse a suite of zero. */
  readonly assertions: number;
  /** Steps that assert nothing. */
  readonly unchecked: number;
}

export function auditScenarios(
  targets: ReadonlyArray<AuditTarget>,
  schema: AuditSchema,
): AuditResult {
  const problems: AuditProblem[] = [];
  let assertions = 0;
  let unchecked = 0;

  for (const { scenario, dataset } of targets) {
    // The union the capture scope masks with (packages/workspace's scopeFor).
    const masked = schema.maskColumns
      ? new Set([...schema.maskColumns, ...(scenario.maskColumns ?? [])])
      : undefined;
    // The scope the run will build (scopeFor again). No `watch` means every
    // table. A `watch` list means exactly those tables, so only the blind ones
    // among them are blind, and the whole-scope form is the author's to keep.
    const allTables = !scenario.watch || scenario.watch.length === 0;
    // The tables a run's scope will hold. The run refuses an `except` or a
    // table outside it, and a `watch:` list is static, so `check` can say so
    // first. Measured: `hasWrite(changes(* except payment_intents)) == false`
    // under `watch: [{table: wallets}]` got `check`'s clean sentence, and every
    // run left it undecided — "`except` names `payment_intents`, which is not
    // being watched, so it excludes nothing (watched: wallets)", exit 3.
    const watched = allTables ? undefined : new Set(scenario.watch!.map((w) => w.table));
    const keyless = schema.keyless;
    const blind = keyless
      ? new Set(allTables ? keyless : scenario.watch!.map((w) => w.table).filter((t) => keyless.has(t)))
      : undefined;

    for (const step of dataset.steps) {
      const at = (message: string): void => {
        problems.push({ scenarioId: scenario.id, datasetId: dataset.id, stepId: step.id, message });
      };
      const list = step.assert ?? [];
      assertions += list.length;
      if (list.length === 0) {
        unchecked++;
        at('checks nothing — it will be observed and verified by no one');
      }

      // The run's own scanner, so this says exactly what the run does: it
      // refuses every one, and `$${` is the escape rather than a reference.
      for (const found of referencesIn(step.request)) {
        at(
          SECRET_REFERENCE.test(found.reference)
            ? `\`${found.field}\` refers to \`${found.reference}\`${found.inKey ? ' in a key' : ''}, and ` +
                'scenario files do not resolve secret references — the run refuses this step rather ' +
                'than send those characters. Put the credential in `identities` in the workspace file ' +
                'and select it with `as:`'
            : `${describeReference(found)}, and a scenario file resolves no \`\${…}\` reference — the ` +
                `run refuses this step rather than send those characters. Instead, ${INSTEAD_OF_A_REFERENCE}`,
        );
      }

      // No check for "a negative assertion with no declared status": the engine
      // treats a missing expectStatus as "a success is expected", so a 4xx fails
      // the step outright. Repeating it here produced a false positive on every
      // step that declared its status as an assertion rather than as
      // expectStatus, which is the commoner spelling.
      for (const source of list) {
        let expr;
        try {
          expr = parse(source);
        } catch {
          // Unparseable: `run` reports it in its own words, with a position.
          continue;
        }

        for (const table of tablesNamedIn(expr)) {
          if (schema.tables.has(table)) continue;
          at(`names table \`${table}\`, which is not in this database`);
        }
        for (const excluded of exceptedTablesIn(expr)) {
          if (schema.tables.has(excluded)) continue;
          at(`excepts \`${excluded}\`, which is not a table here — so it excludes nothing`);
        }
        for (const { table, column } of predicateColumnsIn(expr)) {
          const have = schema.columns.get(table);
          // An unknown table is already reported above; do not say it twice.
          if (!have || have.has(column)) continue;
          at(`matches on \`${table}.${column}\`, which is not a column of \`${table}\``);
        }
        const reads = columnsTouchedBy(expr);
        const misread = new Set<string>();
        for (const { kind, table, column } of reads) {
          if (kind !== 'read' || !table) continue;
          const have = schema.columns.get(table);
          if (!have || have.has(column) || misread.has(`${table}.${column}`)) continue;
          misread.add(`${table}.${column}`);
          at(`reads \`${table}.${column}\`, which is not a column of \`${table}\``);
        }

        // One per assertion: the run stops at the first refusal, and so does
        // this. A second reason for the same undecided line is noise.
        const undecided =
          engineRefusal(expr, { capture: schema.capture, blind, allTables, watched, tables: schema.tables }) ||
          (masked && maskedRefusal(reads, masked, schema.columns));
        if (undecided) at(undecided);
      }
    }
  }

  return { problems, assertions, unchecked };
}

/** `scenario/dataset/step  message`, which is how both callers render one. */
export function formatProblem(problem: AuditProblem, indent = ''): string {
  return `${indent}${problem.scenarioId}/${problem.datasetId}/${problem.stepId}  ${problem.message}`;
}

// ─── what the engine can answer ───────────────────────────────────────────────

/** What is known before a run about what its capture can see. Each part is checked only when given. */
interface EngineFacts {
  readonly capture: { detection: Detection; fidelity: Fidelity } | undefined;
  /** Tables in this scenario's capture scope that a run cannot see a row leave. */
  readonly blind: ReadonlySet<string> | undefined;
  /** No `watch:` list, which is when a question about every table is refused. */
  readonly allTables: boolean;
  /** The `watch:` list's tables; undefined when there is none and every table is watched. */
  readonly watched: ReadonlySet<string> | undefined;
  /** Every table in the database, so a name that is no table at all is left to its own line. */
  readonly tables: ReadonlySet<string>;
}

/**
 * The evaluator's `select` case: every `except` name, then the table, must be in
 * the run's scope, or the run refuses the assertion. Only names that are tables
 * here: one that is not is already reported as that, and this would repeat it.
 */
function scopeRefusal(selector: Selector, facts: EngineFacts): string | undefined {
  const { watched, tables } = facts;
  if (!watched) return undefined;
  for (const excluded of selector.exceptTables ?? []) {
    if (watched.has(excluded) || !tables.has(excluded)) continue;
    return (
      `\`except\` names \`${excluded}\`, which is not being watched, so it excludes nothing ` +
      `(watched: ${[...watched].sort().join(', ')}) — every run leaves this assertion undecided`
    );
  }
  if (selector.table && !watched.has(selector.table) && tables.has(selector.table)) {
    return (
      `table \`${selector.table}\` is not being watched, so nothing can be asserted about it ` +
      `(watched: ${[...watched].sort().join(', ')}) — every run leaves this assertion undecided`
    );
  }
  return undefined;
}

/**
 * The first question in an assertion that this capture cannot answer, worded as
 * the run's refusal is.
 *
 * Mirrors the evaluator's `requireFidelity`, `requireDetection`,
 * `guardSelectionQuestion` and `guardRowIdentity` in
 * packages/expr/src/evaluate.ts. Those are the refusals that depend only on
 * what the engine can do and which tables it can see a row leave. The rest
 * depend on the rows a run captures and cannot be decided here. A node's
 * source is visited before the node, because the evaluator evaluates it first.
 * At one node the guards run in the evaluator's order, because the run stops at
 * the first.
 */
function engineRefusal(expr: Expr, facts: EngineFacts): string | undefined {
  const { capture, blind } = facts;
  const inner = (node: Expr): string | undefined => engineRefusal(node, facts);
  const writeDetection = (what: string): string | undefined =>
    !capture || capture.detection === 'write'
      ? undefined
      : `${what} needs write detection, and this workspace's engine captures with ` +
        `${capture.detection} detection — a value comparison cannot tell a redundant write from ` +
        `no write at all — so every run leaves this assertion undecided`;
  // `guardSelectionQuestion`: counting `updated` or `changes` under value
  // detection is a floor presented as an answer.
  const selectionQuestion = (source: Expr, what: string): string | undefined => {
    const kinds = [...new Set(selectorsUnder(source).map((s) => s.kind))].filter((k) =>
      UNDERCOUNTED_UNDER_VALUE_DETECTION.has(k),
    );
    return kinds.length === 0 ? undefined : writeDetection(`${what} over ${kinds.sort().join(' and ')}`);
  };
  // `guardRowIdentity`: after the detection guard at every node that has both.
  const rowIdentity = (source: Expr, what: string): string | undefined =>
    blind ? rowIdentityRefusal(source, blind, facts.allTables, what) : undefined;

  switch (expr.node) {
    case 'select':
      // The leaf every other node's source reaches first, as in the evaluator.
      return scopeRefusal(expr.selector, facts);
    case 'column':
    case 'predicate':
      return inner(expr.source);
    case 'aggregate':
      return (
        inner(expr.source) ??
        (expr.fn === 'count'
          ? (selectionQuestion(expr.source, 'counting') ?? rowIdentity(expr.source, 'counting'))
          : expr.fn === 'any'
            ? (selectionQuestion(expr.source, 'any()') ?? rowIdentity(expr.source, 'any()'))
            : undefined)
      );
    case 'isEmpty':
      return (
        inner(expr.source) ??
        selectionQuestion(expr.source, 'isEmpty()') ??
        rowIdentity(expr.source, 'isEmpty()')
      );
    case 'hasWrite':
      return inner(expr.source) ?? writeDetection('hasWrite') ?? rowIdentity(expr.source, 'hasWrite()');
    case 'writeCount':
    case 'atomic':
      return (
        inner(expr.source) ??
        (!capture || capture.fidelity === 'transactional'
          ? undefined
          : `${expr.node}() needs the order writes happened in, and this workspace's engine ` +
            `captures with ${capture.fidelity} fidelity — it records where each row ended up, not ` +
            `how it got there — so every run leaves this assertion undecided`)
      );
    case 'compare':
    case 'logical':
      return inner(expr.left) ?? inner(expr.right);
    case 'not':
      return inner(expr.operand);
    default:
      return undefined;
  }
}

/** `UNDERCOUNTED_UNDER_VALUE_DETECTION` in evaluate.ts. */
const UNDERCOUNTED_UNDER_VALUE_DETECTION: ReadonlySet<SelectorKind> = new Set(['updated', 'changes']);

/** `EMPTY_WITHOUT_ROW_IDENTITY` in evaluate.ts. */
const EMPTY_WITHOUT_ROW_IDENTITY: ReadonlySet<SelectorKind> = new Set(['updated', 'deleted']);

/**
 * `guardRowIdentity` in evaluate.ts, worded for a reader who has run nothing
 * yet. It names no engine: the run says which one captured, and all `check`
 * knows is which tables a run cannot see a row leave.
 *
 * Measured before this existed: with a keyless table in the database, `check`
 * gave its clean sentence over `hasWrite(changes(*)) == false`, and every run
 * of the same dataset came back undecided for exactly this reason.
 */
function rowIdentityRefusal(
  source: Expr,
  blind: ReadonlySet<string>,
  allTables: boolean,
  what: string,
): string | undefined {
  if (blind.size === 0) return undefined;
  const selectors = selectorsUnder(source);
  const tables = new Set(selectors.flatMap((s) => (s.table ? [s.table] : [])));
  const named = [...tables].filter((t) => blind.has(t)).sort();
  const empty = [...new Set(selectors.map((s) => s.kind))]
    .filter((k) => EMPTY_WITHOUT_ROW_IDENTITY.has(k))
    .sort();
  if (named.length > 0 && empty.length > 0) {
    return (
      `${what} over ${empty.join(' and ')} of \`${named.join('`, `')}\`, which has no primary key or ` +
      `unique index. This workspace's engine cannot pair a row to its previous version there, so ` +
      `${empty.join(' and ')} is empty however much happened, and every run leaves this assertion ` +
      'undecided. Give the table a key, or ask about `changes` instead'
    );
  }
  if (allTables && tables.size === 0) {
    const excepted = new Set(selectors.flatMap((s) => s.exceptTables ?? []));
    const missing = [...blind].filter((t) => !excepted.has(t)).sort();
    if (missing.length === 0) return undefined;
    return (
      `${what} over every watched table, and \`${missing.join('`, `')}\` ` +
      `${missing.length === 1 ? 'has' : 'have'} no primary key or unique index — a delete there ` +
      'leaves no trace for a run to count, so every run leaves this assertion undecided. ' +
      `Exclude it with \`except ${missing.join(', ')}\`, name the tables you mean in \`watch:\`, ` +
      'or give it a key'
    );
  }
  return undefined;
}

/**
 * The selectors under a node, reached exactly as evaluate.ts's `selectorKinds`,
 * `selectedTables` and `exceptedTables` reach them. That includes the nodes
 * they do not descend into, `logical` and `not`.
 */
function selectorsUnder(expr: Expr, into: Selector[] = []): Selector[] {
  switch (expr.node) {
    case 'select':
      into.push(expr.selector);
      break;
    case 'column':
    case 'aggregate':
    case 'predicate':
    case 'hasWrite':
    case 'isEmpty':
    case 'atomic':
    case 'writeCount':
      selectorsUnder(expr.source, into);
      break;
    case 'compare':
      selectorsUnder(expr.left, into);
      selectorsUnder(expr.right, into);
      break;
    default:
      break;
  }
  return into;
}

// ─── columns ──────────────────────────────────────────────────────────────────

interface ColumnUse {
  /** `match` in a predicate, `read` as a value. */
  readonly kind: 'match' | 'read';
  /** The table the syntax tree names, or undefined under `changes(*)`. */
  readonly table: string | undefined;
  readonly column: string;
}

/** Every column an assertion matches on or reads, in the order the evaluator reaches them. */
function columnsTouchedBy(expr: Expr): ColumnUse[] {
  const found: ColumnUse[] = [];
  // As `predicateColumnsIn` resolves it: the nearest table underneath.
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
  const matches = (predicate: string, table: string | undefined): void => {
    let clauses;
    try {
      clauses = parsePredicate(predicate);
    } catch {
      return; // `parse` has already refused anything this cannot read.
    }
    for (const { column } of clauses) found.push({ kind: 'match', table, column });
  };
  const walk = (node: Expr): void => {
    switch (node.node) {
      case 'select':
        if (node.selector.predicate) matches(node.selector.predicate, node.selector.table);
        return;
      case 'predicate':
        walk(node.source);
        matches(node.predicate, tableOf(node.source));
        return;
      case 'column':
        walk(node.source);
        found.push({ kind: 'read', table: tableOf(node.source), column: node.column });
        return;
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
 * The first masked column an assertion needs the value of, worded as
 * `requireVisible` refuses it at run time.
 *
 * Masking is by column name, in every table (the capture scope gives each table
 * the same list), so a name is masked under `changes(*)` too. A column its
 * table does not have is not masked there — it is misspelled, and reported as
 * that.
 */
function maskedRefusal(
  uses: ReadonlyArray<ColumnUse>,
  masked: ReadonlySet<string>,
  columns: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  for (const { kind, table, column } of uses) {
    if (!masked.has(column)) continue;
    const have = table ? columns.get(table) : undefined;
    if (have && !have.has(column)) continue;
    const name = table ? `${table}.${column}` : column;
    return kind === 'match'
      ? `matches on \`${name}\`, which is masked at capture, so no run has its value to compare. ` +
          'Remove the column from `maskColumns` if the assertion needs it'
      : `reads \`${name}\`, which is masked at capture, so no run has its value. ` +
          'Remove the column from `maskColumns` if the assertion needs it';
  }
  return undefined;
}

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
 * - an **`except`** that names nothing, which therefore excludes nothing and
 *   silently widens the assertion it was written to narrow;
 * - a **step with no assertions**, which will be observed and verified by no
 *   one.
 *
 * Names are resolved from the syntax tree, not by pattern-matching the source.
 * The regex both callers used could only see an identifier in a selector's first
 * argument, so the bare-table shorthand — `sum(delta(wallets.balance))`, which
 * is what `promote` generates — carried a misspelling straight past the command
 * whose only job is catching them.
 */

import { exceptedTablesIn, parse, predicateColumnsIn, tablesNamedIn } from '@tuplescope/expr';
import type { Dataset, Scenario } from '@tuplescope/core';

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
      }
    }
  }

  return { problems, assertions, unchecked };
}

/** `scenario/dataset/step  message`, which is how both callers render one. */
export function formatProblem(problem: AuditProblem, indent = ''): string {
  return `${indent}${problem.scenarioId}/${problem.datasetId}/${problem.stepId}  ${problem.message}`;
}

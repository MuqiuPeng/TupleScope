/**
 * What `check` says about a workspace's panels.
 *
 * Panel sources are expressions in the same language as assertions, resolved
 * against the same schema, and they fail the same way: a misspelled table
 * draws an empty chart rather than an error. `check` is where that is caught.
 *
 * It resolved panel tables and predicate columns but not a column read as a
 * value, so `after(updated(wallets, id = "x").balanse)` passed `check` and
 * drew a line of nothing. The scenario audit resolves value columns; panels
 * are resolved here, so the two stay consistent.
 */

import type { Expr } from '@tuplescope/core';
import { parse, predicateColumnsIn, tablesNamedIn } from '@tuplescope/expr';

export interface PanelSpec {
  title: string;
  sources: Readonly<Record<string, string>>;
}

export function panelProblems(
  panels: ReadonlyArray<PanelSpec>,
  tables: ReadonlySet<string>,
  columns: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const problems: string[] = [];
  for (const panel of panels) {
    for (const [name, source] of Object.entries(panel.sources)) {
      let parsed;
      try {
        parsed = parse(source);
      } catch (error) {
        problems.push(
          `  panel \`${panel.title}\`  source \`${name}\` will not parse: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      for (const table of tablesNamedIn(parsed)) {
        if (tables.has(table)) continue;
        problems.push(
          `  panel \`${panel.title}\`  source \`${name}\` names table \`${table}\`, ` +
            'which is not in this database',
        );
      }
      for (const { table, column } of predicateColumnsIn(parsed)) {
        const have = columns.get(table);
        if (!have || have.has(column)) continue;
        problems.push(
          `  panel \`${panel.title}\`  source \`${name}\` matches on ` +
            `\`${table}.${column}\`, which is not a column of \`${table}\``,
        );
      }
      const misread = new Set<string>();
      for (const { table, column } of valueColumnsIn(parsed)) {
        // An unknown table is reported above, once; this is about its columns.
        const have = columns.get(table);
        if (!have || have.has(column) || misread.has(`${table}.${column}`)) continue;
        misread.add(`${table}.${column}`);
        problems.push(
          `  panel \`${panel.title}\`  source \`${name}\` reads ` +
            `\`${table}.${column}\`, which is not a column of \`${table}\``,
        );
      }
    }
  }
  return problems;
}

/**
 * Every column read as a value, against the nearest table underneath it, as
 * `predicateColumnsIn` resolves a predicate's. Under `changes(*)` there is no
 * one table to resolve against, so those are skipped, exactly as the scenario
 * audit skips them.
 */
function valueColumnsIn(expr: Expr): Array<{ table: string; column: string }> {
  const found: Array<{ table: string; column: string }> = [];
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
  const walk = (node: Expr): void => {
    switch (node.node) {
      case 'column': {
        walk(node.source);
        const table = tableOf(node.source);
        if (table) found.push({ table, column: node.column });
        return;
      }
      case 'predicate':
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

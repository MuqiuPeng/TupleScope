/**
 * Runs a capture engine through the conformance cases.
 *
 * The comparison is deliberately made at the *consumer* boundary, not on the
 * ChangeSet itself. Two engines will always produce ChangeSets that differ in
 * `captureMethod` and `durationMs`, and comparing those away proves nothing.
 * What has to match is the thing a person or an agent ends up reading: the
 * answer to each assertion, and the normalized shape of the rows.
 *
 * The runner never asks which engine it is driving. It reads `detection` and
 * `fidelity` off the adapter, and the cases key their expectations on those.
 * That is the same discipline the consumers are held to by
 * `packages/core/src/abstraction.test.ts` — held here too, because a
 * conformance suite that special-cased an engine would certify the very thing
 * it exists to prevent.
 */

import pg from 'pg';
import type { CaptureScope, ChangeSet, DatabaseAdapter, RowChange, RowsRead } from '@tuplescope/core';
import {
  evaluateAssertion,
  parse,
  predicateClauses,
  rowsSelectorsIn,
  Unevaluable,
} from '@tuplescope/expr';
import type { Answer, Capability, ConformanceCase } from './cases.js';
import { keyLabel } from '@tuplescope/core';

export interface EngineUnderTest {
  /** For the test title only. Nothing in the suite may branch on it. */
  name: string;
  create(connectionString: string): DatabaseAdapter & { fullScope(): Promise<CaptureScope> };
  /**
   * Why this engine cannot run against this server, or null if it can.
   *
   * Some engines need server configuration a test machine may not have — the
   * wal engine needs `wal_level = logical`, which is a restart. Skipping is
   * right; skipping *quietly* is not, because a suite that reports green while
   * silently testing one fewer engine is exactly the failure this whole package
   * exists to prevent. The reason is printed.
   */
  unsupported?(connectionString: string): Promise<string | null>;
}

export interface CaseOutcome {
  case: string;
  /** Assertion source → the answer this engine gave. */
  answers: Record<string, Answer>;
  /** `table:kind:key` → changed columns, sorted. */
  shape: Record<string, string[]>;
  warnings: string[];
  detection: ChangeSet['detection'];
  fidelity: ChangeSet['fidelity'];
  /** `table:operation:key` per mutation, in order. Undefined when not offered. */
  mutations: string[] | undefined;
}

/** Reduces a ChangeSet to the row facts, dropping everything engine-specific. */
export function shapeOf(changes: ChangeSet): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const change of changes.changes) {
    out[shapeKey(change)] = [...change.changedColumns].sort();
  }
  return out;
}

function shapeKey(change: RowChange): string {
  const key = keyLabel(change.key);
  return `${change.table}:${change.kind}:${key}`;
}

export function answerOf(
  source: string,
  changes: ChangeSet,
  lookupRows?: (table: string | undefined, predicate?: string) => RowsRead,
): Answer {
  try {
    const expr = parse(source);
    const result = evaluateAssertion(expr, {
      changes,
      variables: {},
      ...(lookupRows ? { lookupRows } : {}),
    });
    return result.passed ? { status: 'passed' } : { status: 'failed', actual: result.actual };
  } catch (error) {
    // The reason is the whole value of an unevaluable: without it a
    // divergence between two engines is a fact with no explanation.
    if (error instanceof Unevaluable) return { status: 'unevaluable', reason: error.message };
    throw error;
  }
}

/** Every assertion the case mentions, in a stable order. */
export function assertionsOf(testCase: ConformanceCase): string[] {
  return [
    ...Object.keys(testCase.expect),
    ...Object.keys(testCase.expectByDetection ?? {}),
    ...Object.keys(testCase.expectByFidelity ?? {}),
    ...Object.keys(testCase.expectByCapability ?? {}),
  ].sort();
}

/**
 * The answers a case demands of an engine with these capabilities. Returns
 * `undefined` for an assertion the case leaves to the capability tables
 * without covering this particular capability — an omission, which the caller
 * reports rather than silently passing.
 */
/**
 * The answers a case demands of an engine with these capabilities.
 *
 * Returns `undefined` for an assertion no table covers for this combination —
 * an omission the caller reports rather than waving through. An engine with a
 * capability nobody wrote an expectation for must not pass by default.
 *
 * Throws if two tables both claim the same assertion. That is not a
 * hypothetical: `expectByFidelity` used to be applied after `expectByDetection`
 * and silently won, so a case that meant "this depends on both" quietly meant
 * "this depends on fidelity alone". The joint form below is how a case says
 * both — and a collision is a case that has not decided what it means.
 */
export function expectedFor(
  testCase: ConformanceCase,
  detection: ChangeSet['detection'],
  fidelity: ChangeSet['fidelity'],
): Record<string, Answer | undefined> {
  const out: Record<string, Answer | undefined> = { ...testCase.expect };
  const claimedBy = new Map<string, string>();

  const apply = (table: string, entries: Iterable<[string, Answer | undefined]>) => {
    for (const [source, answer] of entries) {
      const already = claimedBy.get(source) ?? (source in testCase.expect ? 'expect' : undefined);
      if (already) {
        throw new Error(
          `${testCase.name}: \`${source}\` has an expectation in both \`${already}\` and ` +
            `\`${table}\`. One would silently override the other. Use \`expectByCapability\` ` +
            `if the answer depends on more than one axis.`,
        );
      }
      claimedBy.set(source, table);
      out[source] = answer;
    }
  };

  apply(
    'expectByDetection',
    Object.entries(testCase.expectByDetection ?? {}).map(([k, t]) => [k, t[detection]]),
  );
  apply(
    'expectByFidelity',
    Object.entries(testCase.expectByFidelity ?? {}).map(([k, t]) => [k, t[fidelity]]),
  );
  apply(
    'expectByCapability',
    Object.entries(testCase.expectByCapability ?? {}).map(([k, t]) => [
      k,
      t[`${detection}/${fidelity}` as Capability],
    ]),
  );

  return out;
}

/** Every assertion whose answer a capability decides, so invariance can skip it. */
export function capabilityExplained(testCase: ConformanceCase): Set<string> {
  return new Set([
    ...Object.keys(testCase.expectByDetection ?? {}),
    ...Object.keys(testCase.expectByFidelity ?? {}),
    ...Object.keys(testCase.expectByCapability ?? {}),
  ]);
}

export function expectedShape(
  testCase: ConformanceCase,
  detection: ChangeSet['detection'],
  fidelity: ChangeSet['fidelity'],
): Record<string, string[]> | undefined {
  const shape =
    testCase.shapeByCapability?.[`${detection}/${fidelity}` as Capability] ??
    testCase.shapeByDetection?.[detection] ??
    testCase.shape;
  if (!shape) return undefined;
  // Column order is Postgres's attribute order, not a fact about the change,
  // so a case should not have to restate it.
  return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, [...v].sort()]));
}

/** Runs one case against one engine and reports what it observed. */
export async function runCase(
  engine: EngineUnderTest,
  connectionString: string,
  schema: string[],
  testCase: ConformanceCase,
): Promise<CaseOutcome> {
  const setup = new pg.Client({ connectionString });
  await setup.connect();
  try {
    // A fresh schema per case, so nothing a previous case wrote can be mistaken
    // for something this one did.
    await setup.query('DROP SCHEMA IF EXISTS conformance CASCADE');
    await setup.query('CREATE SCHEMA conformance');
    for (const ddl of schema) await setup.query(ddl);
    for (const sql of testCase.seed ?? []) await setup.query(sql);
  } finally {
    await setup.end();
  }

  const adapter = engine.create(connectionString);
  try {
    const scope = withIgnoredColumns(await adapter.fullScope(), testCase.maskColumns ?? []);
    const writer = new pg.Client({ connectionString });
    await writer.connect();

    let changes: ChangeSet;
    try {
      ({ changes } = await adapter.capture(scope, async () => {
        for (const sql of testCase.act) {
          // A deliberate ROLLBACK is part of the case, not a failure of it.
          try {
            await writer.query(sql);
          } catch (error) {
            if (!/current transaction is aborted/.test(String(error))) throw error;
          }
        }
      }));
    } finally {
      await writer.end();
    }

    // `rows(...)` reads the rows as they are now, through the adapter, so this
    // has to be here for the same reason it is in the engine: answering from
    // the change set instead is what made `rows` a synonym for `changes`.
    const current = await readCurrentFor(adapter, testCase, scope);
    const answers: Record<string, Answer> = {};
    for (const source of assertionsOf(testCase)) {
      answers[source] = answerOf(source, changes, (table, predicate) => {
        const key = `${table ?? ''}\u0000${predicate ?? ''}`;
        const rows = current.rows.get(key);
        if (rows) return rows;
        const why = current.refusals.get(key);
        // `Unevaluable`, not `Error`: a selector the engine declined to read
        // makes the assertion undecided, which is a verdict the suite can
        // compare against. A bare `Error` escapes as a test failure.
        throw new Unevaluable(why ?? `no rows were read for \`${table ?? '*'}\``);
      });
    }

    return {
      case: testCase.name,
      answers,
      shape: shapeOf(changes),
      warnings: changes.warnings.map((w) => w.code).sort(),
      detection: changes.detection,
      fidelity: changes.fidelity,
      mutations: changes.mutations?.map(
        (m) => `${m.table}:${m.operation}:${keyLabel(m.key)}`,
      ),
    };
  } finally {
    await adapter.close();
  }
}

/** Every `rows(...)` a case asks for, read once through the adapter. */
async function readCurrentFor(
  adapter: DatabaseAdapter,
  testCase: ConformanceCase,
  scope: CaptureScope,
): Promise<{ rows: Map<string, RowsRead>; refusals: Map<string, string> }> {
  const out = new Map<string, RowsRead>();
  const refusals = new Map<string, string>();
  if (!adapter.readRows) return { rows: out, refusals };
  for (const source of assertionsOf(testCase)) {
    let selectors;
    try {
      selectors = rowsSelectorsIn(parse(source));
    } catch {
      continue;
    }
    for (const selector of selectors) {
      if (!selector.table) continue;
      const key = `${selector.table}\u0000${selector.predicate ?? ''}`;
      if (out.has(key)) continue;
      // A refusal is an *answer* here, not a broken case. The suite exists to
      // pin what an engine says, and "this selector cannot be read, because the
      // column is masked" is one of the things it must say — uncaught, it
      // failed the whole case instead, which is the difference between a
      // contract test and a crash.
      try {
        const clauses = selector.predicate ? predicateClauses(selector.predicate) : [];
        out.set(key, await adapter.readRows(selector.table, clauses, scope));
      } catch (error) {
        refusals.set(key, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return { rows: out, refusals };
}

/**
 * `updated_at` is ignored the way a real workspace ignores it — which is what
 * makes the "write to an ignored column only" case mean anything.
 */
function withIgnoredColumns(scope: CaptureScope, maskColumns: ReadonlyArray<string>): CaptureScope {
  return {
    ...scope,
    tables: scope.tables.map((t) => ({
      ...t,
      ignoreColumns: ['updated_at'],
      ...(maskColumns.length > 0 ? { maskedColumns: maskColumns } : {}),
    })),
  };
}

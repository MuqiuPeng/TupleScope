/**
 * Sentences more than one tool says, and the ones worth testing on their own.
 *
 * `server.ts` connects to stdio when it is imported, so anything in it can only
 * be tested by spawning it. What lives here is the text itself: a refusal that
 * names what exists instead of only what does not, a table described from the
 * table rather than from the workspace, and a verdict in prose.
 */

import { exitCodeOf, type RunOutcome, type RunVerdict, type SuiteVerdict } from '@tuplescope/core';

/**
 * An id that names no scenario file, and the ids that do.
 *
 * One implementation, because `check_scenarios` answered the same input with
 * "0 scenario(s) selected" while `get_scenario` named the typo — and
 * `keep_assertion` named it and listed nothing.
 */
export function noSuchScenario(id: string, known: ReadonlyArray<string>): string {
  return `No scenario \`${id}\`. There is: ${known.join(', ') || '(none)'}.`;
}

/**
 * Why a dataset and step name nothing in this scenario, or `undefined` when
 * they name something.
 *
 * The file edit behind `keep_assertion` refuses the same miss, as
 * "<file>: has no dataset `x`", and stops there — the one thing the caller
 * needs next is what there is instead.
 */
export function noSuchStep(
  scenario: {
    readonly id: string;
    readonly datasets: ReadonlyArray<{ readonly id: string; readonly steps: ReadonlyArray<{ readonly id: string }> }>;
  },
  datasetId: string,
  stepId: string,
): string | undefined {
  const dataset = scenario.datasets.find((d) => d.id === datasetId);
  if (!dataset) {
    return (
      `Scenario \`${scenario.id}\` has no dataset \`${datasetId}\`. ` +
      `It has: ${scenario.datasets.map((d) => d.id).join(', ') || '(none)'}.`
    );
  }
  if (!dataset.steps.some((step) => step.id === stepId)) {
    return (
      `Dataset \`${scenario.id}/${datasetId}\` has no step \`${stepId}\`. ` +
      `It has: ${dataset.steps.map((step) => step.id).join(', ') || '(none)'}.`
    );
  }
  return undefined;
}

/**
 * A scenario file that could not be written at all — before it could be
 * validated — without naming the temporary path.
 *
 * The write to the temporary file sat outside the handler that hides that path,
 * so a missing scenarios directory came back as the bare `ENOENT … open
 * '…/x.yaml.mcp-tmp'`: a file the agent never named and that does not exist.
 */
export function notWritten(
  error: unknown,
  where: { temp: string; file: string; scenariosDir: string; configFile: string },
): string {
  if ((error as { code?: unknown } | undefined)?.code === 'ENOENT') {
    return (
      `Not written — there is no scenarios directory at ${where.scenariosDir}.\n\n` +
      `Create it, or point \`scenariosDir\` somewhere else in ${where.configFile}.`
    );
  }
  const detail = (error instanceof Error ? error.message : String(error)).replaceAll(where.temp, where.file);
  return `Not written — ${detail}`;
}

// ─── a verdict ────────────────────────────────────────────────────────────────

/**
 * The verdict in prose, before any structured data.
 *
 * `undecided` gets the longest treatment on purpose: it is the outcome an agent
 * has no prior for, and the one where the intuitive reading — "nothing failed,
 * so it passed" — is exactly backwards.
 */
export function describeVerdict(verdict: RunVerdict | SuiteVerdict): string {
  const exit = exitCodeOf(verdict.outcome);
  const head: Record<RunOutcome, string> = {
    // The verdict's own sentence, which counts what was decided. This said
    // "every assertion evaluated and passed" whatever the counts, and under
    // `unevaluable: "warn"` that sat directly above "2 passed, 0 failed, 2
    // undecided, of 4" — measured through run_scenario against the payment
    // service. Core's reason says "2 of 4 assertions evaluated and passed; 2
    // could not be evaluated and were not counted against this run, by policy".
    clean: `CLEAN (exit ${exit}) — ${verdict.reason}.`,
    failed: `FAILED (exit ${exit}) — the system under test is wrong. ${verdict.reason}`,
    errored: `ERRORED (exit ${exit}) — a step could not be executed. ${verdict.reason}`,
    undecided:
      `UNDECIDED (exit ${exit}) — this is NOT a pass and NOT a failure. The run completed and ` +
      `nothing contradicted it, but ${verdict.reason}. Do not report this as success, and do not ` +
      `tell the user their code is broken: tell them which check could not run, and why.`,
  };

  const lines = [head[verdict.outcome]];
  lines.push(
    `assertions: ${verdict.assertions.passed} passed, ${verdict.assertions.failed} failed, ` +
      `${verdict.assertions.unevaluable} undecided, of ${verdict.assertions.total}.`,
  );
  if (verdict.proves === 'bounded') {
    lines.push(
      '',
      'This run does not establish everything it looks like it does. Carry these when you summarise it:',
      ...verdict.boundedBy.map((bound) => `  · ${bound}`),
    );
  }
  return lines.join('\n');
}

/**
 * Whether a run's result is an error result: for every outcome but `clean`.
 *
 * run_scenario returned a plain result for FAILED (exit 1) and UNDECIDED
 * (exit 3) alike — measured against the payment service, transfer/insufficient
 * and an undecided probe both came back `isError=false` — while
 * check_scenarios states the rule it broke: an agent that reads only `isError`
 * must not be told everything was fine. The call itself did not go wrong, and
 * the text still says which outcome it was; the flag is for the reader who
 * stops at the flag. A record, so a fifth outcome cannot arrive undecided here.
 */
const RUN_IS_ERROR: Readonly<Record<RunOutcome, boolean>> = {
  clean: false,
  failed: true,
  errored: true,
  undecided: true,
};

export function runIsError(outcome: RunOutcome): boolean {
  return RUN_IS_ERROR[outcome];
}

// ─── a table ──────────────────────────────────────────────────────────────────

export interface TableFacts {
  readonly table: string;
  readonly keyStrategy: string;
  /** The table's own columns with their declared types (`format_type`), in table order. */
  readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  /** The workspace's lists as written, not yet applied to this table. */
  readonly ignoreColumns: ReadonlyArray<string>;
  readonly maskColumns: ReadonlyArray<string>;
  readonly capture: { readonly method: string; readonly detection: string; readonly fidelity: string };
}

/**
 * One table, as `describe_table` reports it.
 *
 * `ignored` and `masked` go through the same filter: the workspace's list,
 * narrowed to the columns this table has. They did not. `masked` echoed the
 * workspace's whole `maskColumns` — `passwordHash, tokenHash` on `wallets`,
 * which has neither — while `ignored` came from a scope built without the
 * workspace's list and read `(none)` beside the `updatedAt` it does ignore. A
 * setting that names no column here does nothing here.
 *
 * Each column carries its declared type, modifiers and all (`numeric(18,8)`,
 * not `numeric`): the tool promised types and printed names only, and the type
 * is what decides how a value in an assertion compares.
 */
export function describeTable(facts: TableFacts): string {
  const here = new Set(facts.columns.map((column) => column.name));
  const ignored = facts.ignoreColumns.filter((column) => here.has(column));
  const masked = facts.maskColumns.filter((column) => here.has(column));
  const nameWidth = Math.max(0, ...facts.columns.map((column) => column.name.length));
  const typeWidth = Math.max(0, ...facts.columns.map((column) => column.type.length));
  return [
    facts.table,
    `  row identity  ${facts.keyStrategy}${
      facts.keyStrategy === 'full-row-multiset'
        ? ' — no primary key or unique index, so rows here can be counted but not matched'
        : ''
    }`,
    `  ignored       ${ignored.join(', ') || '(none)'}`,
    `  masked        ${masked.join(', ') || '(none)'}`,
    `  capture       ${facts.capture.method}, ${facts.capture.detection} detection, ` +
      `${facts.capture.fidelity} fidelity`,
    '',
    `  columns (${facts.columns.length}), in table order, with their declared types`,
    ...facts.columns.map(({ name, type }) => {
      const notes = [ignored.includes(name) ? 'ignored' : '', masked.includes(name) ? 'masked' : ''].filter(
        Boolean,
      );
      const head = `    ${name.padEnd(nameWidth)}  `;
      return notes.length > 0 ? `${head}${type.padEnd(typeWidth)}  ${notes.join(', ')}` : `${head}${type}`;
    }),
    '',
    'ignored and masked are the workspace settings as they apply to this table; a scenario can add its own.',
  ].join('\n');
}

// ─── the scope ────────────────────────────────────────────────────────────────

export interface ScopeFacts {
  readonly otherSchemas: ReadonlyArray<{ readonly schema: string; readonly tables: number }>;
  readonly nameFiltered: ReadonlyArray<string>;
  readonly partitionedParents: ReadonlyArray<string>;
  readonly foreignTables: ReadonlyArray<string>;
  /**
   * Watched tables with no primary key and no unique index, and whether this
   * capture can see a row leave each — a fact about the engine and the table
   * together, asked of the scope the engine builds and never of its name.
   */
  readonly keyless: ReadonlyArray<{ readonly table: string; readonly departuresObservable: boolean }>;
}

/**
 * What `describe_workspace` does not watch, or watches only partly. Empty when
 * there is nothing to say.
 *
 * It listed the tables it can observe and nothing else, so a keyless table read
 * like any other and the first an agent heard of it was an undecided run —
 * `hasWrite(changes(*)) == false` refused on the payment service because of one.
 * The cost is stated as the engine has it: the MVCC engines report every change
 * there as an insert and see no delete, so the evaluator refuses what would
 * otherwise pass over real activity (evaluate.ts `guardRowIdentity`); a
 * snapshot diff sees a delete and only loses the pairing.
 */
export function describeScope(facts: ScopeFacts): string[] {
  const out: string[] = [];
  const gaps = [
    ...facts.otherSchemas.map(
      (other) => `${other.schema} (${other.tables} ${other.tables === 1 ? 'table' : 'tables'}, another schema)`,
    ),
    ...facts.nameFiltered.map((name) => `${name} (name begins with _)`),
    ...facts.foreignTables.map((name) => `${name} (foreign table)`),
  ];
  if (gaps.length > 0) out.push(`not watched ${gaps.join(' · ')}`);
  if (facts.partitionedParents.length > 0) {
    // Not a gap — the partitions themselves are watched — but an assertion
    // against the parent's name refuses, and saying so saves the trip.
    out.push(`partitioned ${facts.partitionedParents.join(', ')} — watched through their partitions, not under this name`);
  }

  const blind = facts.keyless.filter((k) => !k.departuresObservable).map((k) => k.table);
  const unpaired = facts.keyless.filter((k) => k.departuresObservable).map((k) => k.table);
  if (blind.length > 0) {
    const one = blind.length === 1;
    out.push(
      `keyless     ${blind.join(', ')} — no primary key or unique index, and this capture cannot pair a ` +
        `row there to its previous version: a change arrives as an insert, and a delete is not seen at all. ` +
        `So count(), any(), isEmpty() and hasWrite() over updated(...) or deleted(...) of ${one ? 'it' : 'them'} ` +
        `come back undecided, as do those questions over every table (changes(*)) in a scenario with no ` +
        `\`watch:\` list unless they say \`except ${blind.join(', ')}\`; and every run that watches ` +
        `${one ? 'it' : 'them'} carries a degraded-row-identity warning, which bounds what it proves. ` +
        `Give ${one ? 'it' : 'each'} a primary key or a unique index.`,
    );
  }
  if (unpaired.length > 0) {
    const one = unpaired.length === 1;
    out.push(
      `keyless     ${unpaired.join(', ')} — no primary key or unique index, so a changed row there cannot be ` +
        `matched to its previous version: an update is reported as a delete and an insert, and a run that ` +
        `changes ${one ? 'it' : 'one'} carries a degraded-row-identity warning, which bounds what it proves. ` +
        `Give ${one ? 'it' : 'each'} a primary key or a unique index.`,
    );
  }
  return out;
}

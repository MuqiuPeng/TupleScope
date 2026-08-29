/**
 * The composition root: config in, a running engine out.
 *
 * This is the one place that knows how a workspace becomes an adapter, a
 * runner and an engine. It exists so the HTTP runtime, the CLI and later MCP
 * are three callers of one assembly rather than three assemblies that drift.
 *
 * The lifetimes differ and the shape has to serve both. The server holds one
 * session for its whole life and closes it on a signal; the CLI opens one, runs
 * a scenario and exits. So construction is synchronous and connects nothing —
 * both pools connect lazily — and everything that can fail because the world is
 * not ready happens in `preflight()`, where the caller can report it properly
 * instead of it surfacing as a stack trace from the first query.
 */

import { createAdapter, type PostgresAdapter } from '@tuplescope/db-postgres';
import { assertResolved } from './credentials.js';
import { HttpRunner } from '@tuplescope/http-runner';
import { ScenarioEngine, loadScenario } from '@tuplescope/scenario-engine';
import type { CaptureScope, Scenario, TableScope } from '@tuplescope/core';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ResolvedWorkspaceConfig } from './config.js';
import { openStore, type RunStore } from './history.js';

export class WorkspaceError extends Error {
  constructor(
    readonly code:
      | 'DATABASE_UNREACHABLE'
      | 'NO_SCENARIOS_DIR'
      /** The database is fine; the chosen capture engine cannot run against it. */
      | 'ENGINE_UNAVAILABLE'
      | 'RESET_NOT_CONFIGURED'
      | 'RESET_FAILED'
      | 'UNKNOWN_TABLE',
    message: string,
    readonly remedy?: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface WorkspaceSession {
  readonly config: ResolvedWorkspaceConfig;
  /**
   * Stored runs, or `undefined` when history is off.
   *
   * Optional so a session can have no filesystem dependency at all, which is
   * what the runtime and MCP want: only the CLI needs to hand a run id back to
   * a later invocation.
   */
  readonly history?: RunStore;
  readonly adapter: PostgresAdapter;
  readonly runner: HttpRunner;
  readonly engine: ScenarioEngine;

  /** Scenario files, re-read from disk each call. */
  scenarios(): Promise<Array<{ scenario: Scenario; file: string }>>;
  /** The capture scope a scenario asks for, resolved against the live schema. */
  scopeFor(scenario: Scenario): Promise<CaptureScope>;
  /** Touches the database once so an unreachable one is reported, not thrown at. */
  preflight(): Promise<{ tables: string[]; columns: Map<string, Set<string>> }>;
  /**
   * Puts the database back to its declared baseline, and nothing else.
   *
   * Separate from running, because they are separate intentions. A run resets
   * so that its evidence means something; a person resets so they can go and
   * look at a clean database, or set one up by hand. Bundling them meant the
   * only way to get a known state was to also destroy it with five requests.
   *
   * Absent when the workspace declares no `resetUrl` — there is nothing to
   * call, and pretending otherwise would fail at the worst moment.
   */
  reset?(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** Overrides the config's `baselineWindowMs`; `0` disables the probe. */
  baselineWindowMs?: number;
  /** How long the reset endpoint gets before it is called failed. */
  resetTimeoutMs?: number;
  /** Stored runs. Off unless asked for; `keep: 0` also disables it. */
  history?: { keep: number } | false;
}

export function openWorkspace(
  config: ResolvedWorkspaceConfig,
  options: OpenOptions = {},
): WorkspaceSession {
  // A reference that skipped resolution would be sent to the API as the
  // literal characters `${secret:…}`, and the failure would read as an
  // authentication problem rather than a missing step.
  assertResolved(config);

  // A lookup, not a branch. Past this line nothing knows which engine was
  // chosen, and the registry is what keeps it that way.
  const adapter = createAdapter(config.engine, {
    connectionString: config.database.connectionString,
    ...(config.maskColumns ? { maskColumns: config.maskColumns } : {}),
  });

  const runner = new HttpRunner({
    baseUrl: config.baseUrl,
    ...(config.identities ? { identities: config.identities } : {}),
  });

  /**
   * One implementation, used by the engine before a full run and by the session
   * when someone asks for a reset on its own.
   *
   * Two copies of "call the reset endpoint" would be two places to get the
   * timeout and the failure message wrong, and the second copy is always the
   * one nobody updates.
   */
  const resetBaseline = async (): Promise<void> => {
    let response: Response;
    try {
      response = await fetch(config.resetUrl!, {
        method: 'POST',
        signal: AbortSignal.timeout(options.resetTimeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new WorkspaceError(
        'RESET_FAILED',
        `Could not reach the reset endpoint at ${config.resetUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'Start the backend, or remove `resetFirst` from the dataset.',
      );
    }
    if (!response.ok) {
      throw new WorkspaceError(
        'RESET_FAILED',
        `The reset endpoint at ${config.resetUrl} answered ${response.status}.`,
        'Check that it wipes and reseeds, and that it accepts POST.',
      );
    }
  };

  const engine = new ScenarioEngine({
    adapter,
    runner,
    baselineWindowMs: options.baselineWindowMs ?? config.baselineWindowMs ?? 0,
    ...(config.resetUrl ? { reset: resetBaseline } : {}),
  });

  const history =
    options.history !== undefined && options.history !== false && options.history.keep > 0
      ? openStore(resolve(config.configDir, '.tuplescope', 'runs'), options.history)
      : undefined;

  const session: WorkspaceSession = {
    config,
    adapter,
    runner,
    engine,
    ...(history ? { history } : {}),
    ...(config.resetUrl ? { reset: resetBaseline } : {}),

    async scenarios() {
      // Re-read every time. The runtime used to serve a copy cached at startup,
      // which meant editing a scenario and pressing Run executed the old one.
      let entries: string[];
      try {
        entries = await readdir(config.scenariosDir);
      } catch (error) {
        // The second command in the README used to answer this with a raw
        // `ENOENT ... scandir` and a Node stack, on a machine that had done
        // nothing wrong — a freshly copied config names a directory that does
        // not exist yet. `status` has always handled its equivalent properly;
        // this is the same courtesy.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new WorkspaceError(
            'NO_SCENARIOS_DIR',
            `No scenarios directory at ${config.scenariosDir}.`,
            `Create it and put a \`.yaml\` scenario in it, or point \`scenariosDir\` somewhere else in ${config.configFile}.`,
          );
        }
        throw error;
      }
      const names = entries
        .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
        .sort();
      const out: Array<{ scenario: Scenario; file: string }> = [];
      for (const name of names) {
        const file = resolve(config.scenariosDir, name);
        out.push({ scenario: await loadScenario(file), file });
      }
      return out;
    },

    async scopeFor(scenario) {
      const ignoreColumns = [...(config.ignoreColumns ?? []), ...(scenario.ignoreColumns ?? [])];
      const maskedColumns = [...(config.maskColumns ?? []), ...(scenario.maskColumns ?? [])];

      // No `watch` observes everything: a hand-picked list quietly hides
      // whatever it forgot, and requiring one before the first run is the main
      // thing standing between a new user and their first diff.
      if (!scenario.watch || scenario.watch.length === 0) {
        return adapter.fullScope({ ignoreColumns, maskedColumns });
      }

      const full = await adapter.fullScope({ ignoreColumns, maskedColumns });
      const byName = new Map(full.tables.map((table) => [table.table, table]));
      return {
        // Carried through from the full scope: narrowing which tables are
        // watched does not change where they live, and a narrowed scope that
        // forgot would produce statements addressing whatever the reader's
        // search path resolves.
        schema: full.schema,
        database: full.database,
        allTables: false,
        tables: scenario.watch.map((spec): TableScope => {
          const base = byName.get(spec.table);
          if (!base) {
            throw new WorkspaceError(
              'UNKNOWN_TABLE',
              `Scenario \`${scenario.id}\` watches \`${spec.table}\`, which is not a table in this database.`,
              `Tables here: ${[...byName.keys()].join(', ') || '(none)'}.`,
            );
          }
          return {
            ...base,
            ...(spec.where !== undefined ? { where: spec.where } : {}),
            ignoreColumns: [...ignoreColumns, ...(spec.ignoreColumns ?? [])],
          };
        }),
      };
    },

    async preflight() {
      // Two failures that look alike and are not. A database nobody can reach
      // is a connection-string problem; an engine that cannot run against a
      // perfectly healthy database is a configuration problem, and telling
      // someone to check whether their running database is running wastes the
      // one moment they were paying attention.
      try {
        await adapter.preflight?.();
      } catch (error) {
        throw new WorkspaceError(
          'ENGINE_UNAVAILABLE',
          `The \`${adapter.captureMethod}\` capture engine cannot run against this database. ${
            error instanceof Error ? error.message : String(error)
          }`,
          `Set a different \`engine\` in ${config.configFile}, or apply the change above.`,
        );
      }
      try {
        // Both in one trip. `check` needs the columns to resolve a predicate,
        // and asking for them separately would be a second connection for a
        // question the same catalogue already answered.
        const [tables, columns] = await Promise.all([adapter.listTables(), adapter.listColumns()]);
        return { tables: [...tables], columns };
      } catch (error) {
        throw new WorkspaceError(
          'DATABASE_UNREACHABLE',
          `Could not reach the database for workspace \`${config.name}\`: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'Check `database.connectionString` in ' + config.configFile + ', and that the database is running.',
        );
      }
    },

    async close() {
      await adapter.close();
    },
  };

  return session;
}

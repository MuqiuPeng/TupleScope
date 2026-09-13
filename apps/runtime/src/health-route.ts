/**
 * Whether the two things a run needs are there, as this runtime's answer to it.
 *
 * `packages/workspace/src/reachability.ts` owns the judgement and the shape;
 * this owns the wiring the runtime adds to it — which surface touches the
 * database how, and where the scrub goes. Its own module for the reason
 * `reset-route.ts` and `assertion-route.ts` are: a route inside `main()` can
 * only be tested by booting a server, and the bugs these routes have had were
 * found by the tests that sent the request the page sends.
 *
 * Three callers, one implementation, deliberately: `/api/workspace` on page
 * load, `/api/health` on every window focus, and the refusal in front of
 * `POST /api/run-jobs`. The defect this whole change exists to remove was one
 * judgement with three copies, and copies inside a single file drift just as
 * well as copies across three.
 *
 * The two surfaces differ in only one thing, which is why `touchDatabase` is a
 * parameter: page load wants the table *names* and so pays for a listing,
 * while a focus poll wants only to know whether the database is there and must
 * not pay for one.
 */

import type { FastifyInstance } from 'fastify';
import {
  databaseReachable,
  databaseUnreachable,
  probeBackend,
  type Reachability,
} from '@tuplescope/workspace';
import { scrubDeep, type Scrub } from './scrub.js';

/** What a database touch has to come back with for it to be reportable. */
export interface DatabaseLiveness {
  readonly tables: number;
  readonly schema: string;
}

export interface ReachabilityOptions {
  /**
   * Whatever this surface was going to do to the database anyway, returning the
   * count and schema its answer will name. Throwing is the unreachable case.
   */
  readonly touchDatabase: () => Promise<DatabaseLiveness>;
  /** Resolved, so the probe goes where a run's requests would go. */
  readonly baseUrl: string;
  /**
   * A driver's sentence can carry the password from the connection string, and
   * `baseUrl` is a URL people do put credentials in. These values travel inside
   * a 200, where `scrubErrorBodies` never sees them.
   */
  readonly scrub: Scrub;
  /** Overridable so a test neither opens a socket nor waits for a timeout. */
  readonly probe?: (baseUrl: string) => Promise<Reachability>;
  readonly now?: () => Date;
}

export interface HealthRouteOptions extends Omit<ReachabilityOptions, 'touchDatabase'> {
  /**
   * The cheapest question that still proves the database is there.
   * `adapter.ping()`, not `adapter.listTables()`: the page calls this route on
   * every window focus.
   */
  readonly pingDatabase: () => Promise<DatabaseLiveness>;
}

/**
 * The remedy for a database that did not answer, when whatever threw named none.
 *
 * A `WorkspaceError` from `preflight()` carries one that names the config file;
 * a driver error carries only its own sentence, and that sentence never says
 * what to do about it.
 *
 * Exported, and takes its follow-up as an argument, because three spellings of
 * this one fact had appeared across the surfaces this refactor was meant to
 * unify — and a reader refused before a run, who then loses the database mid-run,
 * met two different sentences about the same thing. What legitimately differs is
 * only the verb: a run was refused, so run again; a health check was asked, so
 * check again.
 */
export const startTheDatabase = (next: 'check' | 'run' = 'check'): string =>
  `Start the database for this workspace, then ${next} again.`;

const START_THE_DATABASE = startTheDatabase();

/** The unreachable answer, from whatever was thrown at us. Not scrubbed here. */
function databaseDown(
  error: unknown,
  options: { readonly now?: () => Date } = {},
): Reachability {
  const remedy = (error as { remedy?: unknown }).remedy;
  return databaseUnreachable(
    {
      reason: error instanceof Error ? error.message : String(error),
      remedy: typeof remedy === 'string' && remedy !== '' ? remedy : START_THE_DATABASE,
    },
    options,
  );
}

/**
 * The database's answer, built from what touching it did or threw.
 *
 * Not scrubbed: a caller sending this inside an error body must leave that to
 * `scrubErrorBodies`, which covers every body over 400 exactly once — and
 * scrubbing twice is not harmless (see `scrub.ts`).
 */
async function checkDatabase(
  touch: () => Promise<DatabaseLiveness>,
  options: { readonly now?: () => Date } = {},
): Promise<Reachability> {
  try {
    return databaseReachable(await touch(), options);
  } catch (error) {
    return databaseDown(error, options);
  }
}

/**
 * Both answers, for a 200 body: scrubbed, and taken at the same time.
 *
 * Concurrently, because these are two independent questions and a page that
 * waits for a three-second backend timeout before it starts asking about the
 * database takes six seconds to tell someone that both are down.
 */
async function reachabilityOf(
  options: ReachabilityOptions,
): Promise<{ database: Reachability; backend: Reachability }> {
  const at = options.now ? { now: options.now } : {};
  const probe = options.probe ?? ((baseUrl: string) => probeBackend(baseUrl, at));
  const [database, backend] = await Promise.all([
    checkDatabase(options.touchDatabase, at),
    probe(options.baseUrl),
  ]);
  return {
    database: scrubDeep(database, options.scrub),
    backend: scrubDeep(backend, options.scrub),
  };
}

/** What `/api/workspace` needs from the database, and nothing more of it. */
export interface WorkspaceProbeAdapter {
  ping(): Promise<DatabaseLiveness>;
  listTables(): Promise<ReadonlyArray<string>>;
}

/**
 * What `/api/workspace` reports about both dependencies, plus the table names.
 *
 * Here rather than in `server.ts` so the empty listing is not a claim nobody
 * checks: with the database down this route answers 200, and the field the page
 * renders its table list from has to be empty rather than stale or absent.
 */
export async function workspaceReachability(options: {
  readonly adapter: WorkspaceProbeAdapter;
  readonly baseUrl: string;
  readonly scrub: Scrub;
  readonly probe?: (baseUrl: string) => Promise<Reachability>;
  readonly now?: () => Date;
}): Promise<{ tables: ReadonlyArray<string>; database: Reachability; backend: Reachability }> {
  let tables: ReadonlyArray<string> = [];
  const { database, backend } = await reachabilityOf({
    ...options,
    touchDatabase: async () => {
      // `ping()` for the schema, then the listing the page renders. The count
      // reported is the length of *that* list and not the ping's own count, so
      // the sentence beside the indicator and the tables on screen cannot come
      // from two different answers.
      const { schema } = await options.adapter.ping();
      tables = await options.adapter.listTables();
      return { tables: tables.length, schema };
    },
  });
  // Empty when either call threw: the page lists what we could actually see,
  // which with the database down is nothing.
  return { tables, database, backend };
}

export interface RunRefusal {
  readonly status: number;
  readonly body: {
    readonly error: 'DATABASE_UNREACHABLE';
    readonly message: string;
    readonly remedy?: string;
    /**
     * So the page can move its indicator from the refusal itself, `checkedAt`
     * included, instead of waiting for the next poll to explain what happened.
     */
    readonly database: Reachability;
  };
}

/**
 * The refusal to put in front of a run, or `undefined` when the database answered.
 *
 * Necessary because `/api/workspace` no longer answers 503: submitting a run
 * became reachable in exactly the state where a run can prove nothing. Of the
 * three things that could happen next, this is the only defensible one — a
 * half-run sends real requests that write real rows and then reports nothing
 * about any of them, and a run that dies during capture blames whichever step
 * was unlucky. A tool for proving what happened to a database must not start a
 * run it cannot observe.
 *
 * Nothing here is scrubbed: this becomes an error body, and `scrubErrorBodies`
 * covers those exactly once.
 */
export async function runRefusal(options: {
  readonly pingDatabase: () => Promise<DatabaseLiveness>;
  /** Named in the message: a person may be running more than one workspace. */
  readonly workspace: string;
  readonly now?: () => Date;
}): Promise<RunRefusal | undefined> {
  const at = options.now ? { now: options.now } : {};
  const database = await checkDatabase(options.pingDatabase, at);
  // `=== 'unreachable'`, never `!== 'reachable'`. Telling someone to start a
  // database that is already running — because all we truly know is that nobody
  // asked — is how a person learns to distrust every state this reports.
  if (database.state !== 'unreachable') return undefined;
  return {
    // Not the runtime's fault and not the request's: a dependency this run needs
    // is not there, which is what 503 says.
    status: 503,
    body: {
      error: 'DATABASE_UNREACHABLE',
      message:
        `The database for workspace \`${options.workspace}\` is not reachable, so this run ` +
        `could not observe what it writes: ${database.reason}`,
      ...(database.remedy ? { remedy: database.remedy } : {}),
      database,
    },
  };
}

/**
 * `GET /api/health` — the same two values, and nothing else.
 *
 * Answers 200 whatever it finds. The states are the report; a non-200 would
 * make the page's own fetch the thing that failed, and there would be nothing
 * to render the indicators from.
 *
 * Not `/health`, which is a different question with a different audience: that
 * one says whether this process is up, is public by design, and names nothing
 * about a workspace. This one reports what a run needs and is guarded like the
 * rest of `/api`, because a reason can name the database and the backend.
 */
export function registerHealthRoute(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/api/health', async () =>
    reachabilityOf({ ...options, touchDatabase: options.pingDatabase }),
  );
}

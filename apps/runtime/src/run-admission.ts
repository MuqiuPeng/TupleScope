/**
 * Deciding whether a run may start, and claiming the slot if it may.
 *
 * Its own module for the same reason `assertion-route.ts` and `reset-route.ts`
 * are: the rule is testable here and was not testable inside `main()`, which is
 * one long function holding a real workspace and a real adapter. A rule nobody
 * can test from outside is a rule that gets a test written against a copy of
 * itself, and that is what happened — a test that rebuilt this handler by hand
 * and therefore stayed green while the real one was wrong.
 *
 * The ordering here is the whole point, and it is not obvious:
 *
 *   1. refuse a second run  — synchronous, against the live job map
 *   2. claim the slot       — synchronous, in the same tick as (1)
 *   3. ask the database     — `await`, and only now
 *   4. hand the slot back if (3) refuses
 *
 * The database question was originally asked between (1) and (2). Two POSTs
 * arriving inside one round trip then both read an empty job map and both got
 * 202 — measured, three attempts out of three, and twice they were handed the
 * same id, so registering the second dropped the first while it was still
 * writing. Two runs against one database is the worst state this product can
 * reach: the second run's writes land inside the first's baseline window and are
 * reported as the first's, and a `resetFirst` dataset in one wipes rows the
 * other has already captured. A tool whose only promise is "this is what your
 * request wrote" must never be in that state, so steps 1 and 2 may never be
 * separated by an `await` again.
 */

export interface RunSlot {
  readonly id: string;
  status: 'running' | 'finished' | 'errored';
}

/** What `runRefusal` answers with, kept structural so this module imports nothing. */
export interface Refusal {
  readonly status: number;
  readonly body: unknown;
}

export type Admission<J> =
  | { readonly admitted: true; readonly job: J }
  | ({ readonly admitted: false } & Refusal);

export interface RunAdmissionOptions<J extends RunSlot> {
  /** The live job map. Read and written in place: callers hold the same map. */
  readonly jobs: Map<string, J>;
  /** Builds the job once an id is minted. */
  readonly create: (id: string) => J;
  /**
   * Whatever must be true of the world before a run starts — today, that the
   * database answers. Asked after the slot is claimed, never before.
   */
  readonly refuse: () => Promise<Refusal | undefined>;
  /**
   * How many finished jobs to keep. A UI session needs only its recent ones;
   * bounding the map keeps a long-lived runtime from becoming a history store.
   */
  readonly keep?: number;
  /** Injectable so a test can put two admissions in one millisecond. */
  readonly clock?: () => number;
}

const KEEP = 30;

export function createRunAdmission<J extends RunSlot>(
  options: RunAdmissionOptions<J>,
): () => Promise<Admission<J>> {
  const clock = options.clock ?? Date.now;
  const keep = options.keep ?? KEEP;
  // Unique per runtime, not merely per millisecond. The timestamp stays because
  // it makes a job id readable in a log; the counter is what makes it an id.
  let sequence = 0;

  return async function admit(): Promise<Admission<J>> {
    const active = [...options.jobs.values()].find((job) => job.status === 'running');
    if (active) {
      return {
        admitted: false,
        status: 409,
        body: {
          error: 'RUN_IN_PROGRESS',
          message: 'A dataset is already running in this workspace.',
          jobId: active.id,
        },
      };
    }

    // Same tick as the check above. See this file's header for what separating
    // them cost.
    const id = `job_${clock().toString(36)}_${(++sequence).toString(36)}`;
    const job = options.create(id);
    options.jobs.set(id, job);
    while (options.jobs.size > keep) {
      options.jobs.delete(options.jobs.keys().next().value!);
    }

    const refusal = await options.refuse();
    if (refusal) {
      // Claimed before the round trip, so it has to be handed back. Left in
      // place, a refused run is a `running` job nothing will ever finish, and
      // every later run answers 409 about a run that never started.
      options.jobs.delete(id);
      return { admitted: false, status: refusal.status, body: refusal.body };
    }

    return { admitted: true, job };
  };
}

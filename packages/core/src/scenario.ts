/**
 * Scenario definitions — the file format users actually author.
 *
 * The two-level shape (scenario -> datasets -> steps) matters: each dataset
 * carries its own complete step list rather than patching a shared one, so what
 * you selected is exactly what ran. A patch-based variant makes "what did this
 * run actually do?" unanswerable, which is the one question this whole product
 * exists to answer.
 */

/** Bumped only on a breaking format change. Present from v0.1 so it can be. */
export type ScenarioFormatVersion = 1;

export interface Scenario {
  version: ScenarioFormatVersion;
  id: string;
  title: string;
  /** Why this flow matters. Shown above the datasets; not executable. */
  why?: string;

  /**
   * Narrows observation to these tables. Optional on purpose.
   *
   * Omitting it observes every table, which is the better default: a
   * hand-picked list quietly hides whatever it forgot, and requiring one up
   * front is the main thing standing between a new user and their first diff.
   * Narrow it later, once you know what you care about.
   */
  watch?: ReadonlyArray<WatchSpec>;

  /** Applied to every table unless a WatchSpec overrides it. */
  ignoreColumns?: ReadonlyArray<string>;
  /**
   * Columns redacted before the value leaves the database adapter — not at
   * render time. Run history, `--json` output and CI reports all persist
   * captured values, so masking anywhere downstream of capture leaks.
   */
  maskColumns?: ReadonlyArray<string>;

  datasets: ReadonlyArray<Dataset>;
}

export interface WatchSpec {
  table: string;
  /**
   * Narrowing predicate, e.g. `customer_id = {{customer_id}}`. Templated
   * before use. Note that narrowing makes row absence ambiguous — the engine
   * distinguishes `delete` from `left-scope` accordingly.
   */
  where?: string;
  ignoreColumns?: ReadonlyArray<string>;
}

/**
 * One runnable variant of a scenario.
 *
 * Most scenarios should ship a happy path plus datasets that trip a specific
 * guard. An API is only as good as what it refuses, and a suite that is all
 * green by construction tests nothing.
 */
export interface Dataset {
  id: string;
  label: string;
  /** One line on what this variant demonstrates. */
  note?: string;
  /**
   * Wipe and reseed before running. Needed wherever a flow consumes a quota or
   * a uniqueness slot, since back-to-back runs would otherwise collide on the
   * second attempt rather than on any real defect.
   */
  resetFirst?: boolean;
  steps: ReadonlyArray<Step>;
}

export interface Step {
  id: string;
  name: string;
  request: HttpRequest;

  /** Pulls values out of the response for later steps. `{ payment_id: 'response.body.id' }`. */
  capture?: Readonly<Record<string, string>>;

  /**
   * Prose for the reader: "intent COMPLETED, balance credited, ledger row
   * written". Deliberately separate from `assert` — this is what a person
   * should understand, `assert` is what the machine can prove. Where the two
   * disagree, the prose is a bug report.
   */
  expect?: string;

  /**
   * Marks a step whose expected outcome IS the rejection. The runner scores it
   * as a pass and the UI badges it amber rather than red. Without this, every
   * negative case has to be written as a failure the reader must learn to
   * ignore, and a suite whose red is sometimes fine stops being read at all.
   */
  expectStatus?: number;

  /** Expressions evaluated against response + ChangeSet. See `assertion.ts`. */
  assert?: ReadonlyArray<string>;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  /** Templated. `/payments/{{payment_id}}/refund`. */
  path: string;
  /**
   * Which configured identity to send as. Multi-party flows — transfers,
   * shared baskets, approval chains — cannot be expressed with a single ambient
   * token, and every interesting state machine is multi-party.
   */
  as?: string;
  headers?: Readonly<Record<string, string>>;
  /** Templated. Sent as `Idempotency-Key`; pair with `{{run}}` to stay unique across runs. */
  idempotencyKey?: string;
  body?: unknown;

  /**
   * Off by default, and that is load-bearing: a transparent retry writes twice
   * and turns an idempotency test into a coin flip.
   */
  retry?: { attempts: number; backoffMs: number };
  /** Off by default — following a redirect hides the 3xx the assertion may be about. */
  followRedirects?: boolean;
  timeoutMs?: number;
}

/**
 * Built-in variables, available to every template alongside captured values.
 *
 * `run` is the one that matters: a per-execution suffix that keeps idempotency
 * keys unique between runs. Without it a dataset passes once and then fails on
 * every subsequent run by replaying its own previous key — which reads as a
 * product bug and is the fastest way to lose a new user.
 */
export interface BuiltinVariables {
  /** Short unique suffix, stable for the whole run. */
  run: string;
  /** ISO-8601 timestamp at run start. */
  now: string;
}

/**
 * Resolution order, most specific first. A name found earlier wins.
 */
export const VARIABLE_PRECEDENCE = [
  'step',
  'dataset',
  'scenario',
  'environment',
  'workspace',
  'builtin',
] as const;

export type VariableSource = (typeof VARIABLE_PRECEDENCE)[number];

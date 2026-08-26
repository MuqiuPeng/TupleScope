/**
 * Execution results.
 *
 * Note what is absent: there is no `snapshots[]`. Snapshots are one engine's
 * internal state, and putting them in the run record would leak the capture
 * mechanism into everything that reads a run — the UI, run history, the CLI's
 * JSON, CI reports.
 */

import type { AssertionResult } from './assertion.js';
import type { ChangeSet, CaptureWarning } from './changeset.js';

export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'errored' | 'skipped';

export interface Run {
  id: string;
  scenarioId: string;
  datasetId: string;
  /**
   * Which steps ran. `partial` means the run started mid-dataset, so earlier
   * steps' effects are whatever the previous run left behind — worth saying,
   * because a green partial run proves less than a green full one.
   */
  coverage: 'full' | 'partial';
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;

  /**
   * Whether the idle observation ran, and for how long.
   *
   * Required, and separate from `baselineNoise`, because "the probe found
   * nothing" and "the probe never ran" are opposite facts that an absent field
   * conflates. Only the first is evidence of a quiet database; the second means
   * concurrent writes would not have been detected at all, and a verdict has to
   * say so.
   */
  baseline: { probed: boolean; windowMs: number };

  /**
   * What the idle observation saw. Present whenever the probe ran and found
   * something: it means something other than this scenario writes to the
   * database, so some rows below may not be ours.
   */
  baselineNoise?: ChangeSet;

  steps: ReadonlyArray<StepResult>;
  /** Values captured across the run, for display and for reruns. */
  variables: Readonly<Record<string, string>>;
}

export interface StepResult {
  stepId: string;
  name: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;

  request: RecordedRequest;
  response?: RecordedResponse;
  /** Absent only when the step failed before observation could complete. */
  changes?: ChangeSet;
  assertions: ReadonlyArray<AssertionResult>;
  error?: ExecutionError;
  /**
   * Assertions derived from what this step actually changed, ready to be kept.
   * See `AssertionCandidate` — this is the observe-then-promote loop, and the
   * reason to reach for this tool over a hand-written integration test.
   */
  candidates?: ReadonlyArray<AssertionCandidate>;
}

/**
 * Values here are already masked. Masking happens at capture, so nothing
 * downstream — history on disk, `--json`, a CI artifact — ever holds the
 * original.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** Identity the request was sent as, if any. */
  as?: string;
}

export interface RecordedResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body?: string;
  durationMs: number;
}

/**
 * Errors are typed because the remedy differs per class, and "something went
 * wrong" wastes the one moment the user is willing to debug the tool instead of
 * their own code.
 */
export type ErrorKind =
  | 'request'
  | 'database'
  | 'capture'
  | 'assertion'
  | 'configuration'
  | 'credential'
  | 'plugin';

export interface ExecutionError {
  kind: ErrorKind;
  message: string;
  /** What to try, shown as the primary action. `Start the backend on :8000`. */
  remedy?: string;
  cause?: string;
}

/**
 * Turns an observed change into an assertion the user can keep.
 *
 * This is the loop the product is for. Without it the honest answer to "why not
 * write pytest and a few SQL assertions?" is that there isn't one — hand-written
 * tests are more precise, and their only weakness is that you must already know
 * the answer. Observing first and promoting second is the part a test file
 * cannot do.
 */
export interface AssertionCandidate {
  /** Generated expression, ready to paste into `assert:`. */
  expression: string;
  /** What it will check, in prose. `wallet wal_alice balance falls by 100.00`. */
  description: string;
  /** The change this was derived from, for highlighting in the diff view. */
  changeIndex: number;
  /**
   * Set when the candidate cannot be honoured by the current engine — e.g. a
   * mutation count under `value` detection. Offer it, but say so.
   */
  caveat?: CaptureWarning;
}

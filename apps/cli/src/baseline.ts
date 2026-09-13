/**
 * The idle window this invocation watches before a run — one answer, used by
 * the session that watches and by the envelope that reports it.
 *
 * They were computed apart, and the envelope's side read the workspace file.
 * Measured: `run --baseline 0`, `--baseline off` and `--baseline 1000` all
 * stored `policy.baselineWindowMs: 400`, the workspace's value, while
 * `runs[0].run.baseline` said `{probed:false, windowMs:0}` and `{probed:true,
 * windowMs:1000}`. The policy block is where a CI reader looks to learn whether
 * concurrent writes could have been noticed, and it named a window that was
 * never watched.
 */

/** What `--baseline <ms|off>` asks for, or `undefined` when it was not given. */
export function baselineOverride(flag: string | undefined): number | undefined {
  if (flag === undefined) return undefined;
  return flag === 'off' ? 0 : Number(flag);
}

/**
 * The window in effect: the flag, else the workspace's `baselineWindowMs`,
 * else 0 — the same fallback `openWorkspace` gives the engine.
 */
export function baselineWindowFor(flag: string | undefined, configured: number | undefined): number {
  return baselineOverride(flag) ?? configured ?? 0;
}

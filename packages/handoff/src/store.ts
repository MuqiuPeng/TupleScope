/**
 * Reading and writing `~/.statescope/handoff.json`.
 *
 * Mode 0600 and write-temp-then-rename, the same as any credential store — not
 * because it holds credentials (it holds none) but because it holds *decisions
 * about what may run*, and a half-written decision is one nobody made.
 *
 * The store is deliberately unaware of what a binding is for. It parses,
 * refuses, and hands back the contract; the targets decide what to do with it.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  grantKey,
  HANDOFF_CONFIG_VERSION,
  HANDOFF_POLICY_VERSION,
  HandoffConfigError,
  parseHandoffConfig,
  type Binding,
  type HandoffConfigV1,
  type WorkspaceGrant,
} from './config.js';

/** `~/.statescope/handoff.json`, unless the caller is a test. */
export function defaultConfigPath(): string {
  return join(homedir(), '.statescope', 'handoff.json');
}

const EMPTY: HandoffConfigV1 = { v: HANDOFF_CONFIG_VERSION, bindings: {} };

/**
 * The config as it is on disk.
 *
 * An absent file is an empty config — not an error. Nobody has bound anything
 * yet, which is the state every machine starts in and the state a refusal
 * should read as.
 *
 * A *malformed* file is an error, and it propagates. Treating it as empty would
 * silently discard whatever the user set up and then tell them the alias is
 * unbound.
 */
export async function loadHandoffConfig(
  path = defaultConfigPath(),
  options: { allowRemote?: boolean } = {},
): Promise<HandoffConfigV1> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new HandoffConfigError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseHandoffConfig(raw, options);
}

/**
 * Writes the config, atomically and privately.
 *
 * `chmod` on the temporary file *before* the rename: setting the mode after
 * would leave a window in which the final path is world-readable, and the
 * rename is the moment the path becomes real.
 */
export async function saveHandoffConfig(
  config: HandoffConfigV1,
  path = defaultConfigPath(),
): Promise<void> {
  // Through the validator, not around it. The writer used to accept whatever it
  // was handed, so `handoff enable` could store a binding the reader refuses —
  // a Windows `C:\\...psql.exe` is the ordinary way to reach that state. And a
  // refusal is per *file*, not per binding: one unreadable entry takes every
  // other binding down with it, including working ones, and every CLI path back
  // out has to load the file first.
  //
  // `allowRemote` is deliberately on. It governs whether a *remote* origin may
  // be bound at all — a decision the enable path already made, with its own
  // confirmation — and re-deciding it here would make a saved config
  // unsaveable on its next rewrite.
  parseHandoffConfig(JSON.parse(JSON.stringify(config)), { allowRemote: true });

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/**
 * The workspace path a grant is keyed on.
 *
 * Realpath'd, so a symlink into the project, or a git worktree pointing at it,
 * cannot present itself as an already-approved workspace.
 */
export async function workspaceKey(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    // A path that does not resolve cannot match an existing grant, which is the
    // safe outcome. Returning the input keeps the message readable.
    return root;
  }
}

export interface GrantRequest {
  alias: string;
  binding: Binding;
  workspace: string;
  now: string;
}

/**
 * Adds a grant, replacing any earlier one for the same workspace.
 *
 * Replacing rather than appending: a stale grant recorded under an older
 * `policyVersion` must not sit beside a current one, or a later narrowing of
 * what counts as granted would find the old row and pass.
 */
export function withGrant(config: HandoffConfigV1, request: GrantRequest): HandoffConfigV1 {
  const grant: WorkspaceGrant = {
    workspace: request.workspace,
    approvedAt: request.now,
    approvedBy: safeUser(),
    policyVersion: HANDOFF_POLICY_VERSION,
  };
  const kept = request.binding.grants.filter((g) => g.workspace !== request.workspace);
  return {
    v: HANDOFF_CONFIG_VERSION,
    bindings: {
      ...config.bindings,
      [request.alias]: { ...request.binding, grants: [...kept, grant] } as Binding,
    },
  };
}

/** Removes a binding entirely. Revoking one workspace's grant is `withoutGrant`. */
export function withoutBinding(config: HandoffConfigV1, alias: string): HandoffConfigV1 {
  const bindings = { ...config.bindings };
  delete bindings[alias];
  return { v: HANDOFF_CONFIG_VERSION, bindings };
}

/** Removes one workspace's grant, leaving the binding for other workspaces. */
export function withoutGrant(
  config: HandoffConfigV1,
  alias: string,
  workspace: string,
): HandoffConfigV1 {
  const binding = config.bindings[alias];
  if (!binding) return config;
  return {
    v: HANDOFF_CONFIG_VERSION,
    bindings: {
      ...config.bindings,
      [alias]: {
        ...binding,
        grants: binding.grants.filter((g) => g.workspace !== workspace),
      } as Binding,
    },
  };
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

export { grantKey };

/**
 * `~/.tuplescope/handoff.json` — the file a repository cannot write.
 *
 * The whole trust model of the row handoff lives in this split. A project's
 * `tuplescope.yaml` contributes exactly one string: an **alias**, which is
 * inert until the user binds it here. There is no `command:`, no `env:`, no
 * `url:`, no `service:`, no `path:`, no `server:` — a config key whose value is
 * a path to a program is a command-execution primitive, and a repo-committed
 * consent flag is the repo author consenting on the user's behalf.
 *
 * So: which mechanism runs, where it points, and which workspaces it is granted
 * to are all decided here, by the person at the keyboard, and nowhere else.
 */

import { isAbsolute } from 'node:path';

export const HANDOFF_CONFIG_VERSION = 1;

/**
 * Bumped when TupleScope widens what a preset may do.
 *
 * A grant records the version it was given under, so widening the capability
 * re-asks instead of silently inheriting an approval for something narrower.
 */
export const HANDOFF_POLICY_VERSION = 1;

export interface HandoffConfigV1 {
  readonly v: 1;
  /** Keyed by alias — the one string `tuplescope.yaml` is allowed to contribute. */
  readonly bindings: Readonly<Record<string, Binding>>;
}

export type Binding = AdminerBinding | PsqlServiceBinding;

interface BindingCommon {
  /** Realpath'd workspace roots this binding is granted to. Never a glob. */
  readonly grants: ReadonlyArray<WorkspaceGrant>;
}

export interface AdminerBinding extends BindingCommon {
  readonly preset: 'adminer-url';
  /** Where the browser goes. Origin only: scheme, host, port. No path, no query. */
  readonly origin: string;
  /**
   * PostgreSQL **as Adminer reaches it** — `hostname[:port]`.
   *
   * Not TupleScope's DSN host, and not derivable from it. Measured with
   * TupleScope on the host and both Adminer and PostgreSQL in containers, three
   * independent addresses were in play: Adminer's HTTP origin `127.0.0.1:7442`,
   * PostgreSQL as TupleScope reaches it `127.0.0.1:7441`, and PostgreSQL as
   * Adminer reaches it `172.17.0.3:5432`. The third means nothing to the first
   * two, and the divergence is the ordinary case for any Compose stack.
   */
  readonly server: string;
  /**
   * The role Adminer is logged in as.
   *
   * Part of Adminer's session key `(driver, server, username, db)`. Measured: a
   * URL with the wrong username — or none — renders the login page, and that
   * page echoes the full request, key value included, into its own recent-links
   * list. TupleScope knows a username from its own DSN, but the DSN is the
   * thing this design refuses to hand out.
   */
  readonly username: string;
}

export interface PsqlServiceBinding extends BindingCommon {
  readonly preset: 'psql-service';
  /** A key in `pg_service.conf`. TupleScope never reads that file. */
  readonly service: string;
  /** Absolute, resolved once at enable time. */
  readonly executable: string;
  /** `realpath(executable)` at enable time; re-checked at spawn. */
  readonly realpath: string;
}

export interface WorkspaceGrant {
  /** `realpath(workspaceRoot)`, so a symlink or a worktree cannot alias in. */
  readonly workspace: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly policyVersion: number;
}

// ─── validation ───────────────────────────────────────────────────────────────

/**
 * Refusals, never coercions.
 *
 * Everything here is read from a file on the user's disk and turned into an
 * address a browser opens or a program that runs. A validator that "fixes" a
 * malformed value is one that decides, on the user's behalf, what they meant.
 */
export class HandoffConfigError extends Error {
  override readonly name = 'HandoffConfigError';
}

export const ALIAS = /^[a-z][a-z0-9-]{0,31}$/;
export const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SERVER = /^[A-Za-z0-9._-]{1,253}(:\d{1,5})?$/;
/**
 * No control characters, and none of the URL delimiters.
 *
 * Two reasons, and the first is the one that matters. The user is shown the
 * exact string that will be opened; a control character in it is invisible in
 * the one place they get to check it. The delimiters are defence in depth — the
 * URL is built with `URLSearchParams`, which encodes every component, so they
 * are already harmless unless someone later replaces that with concatenation.
 *
 * Written as an explicit set, not `[^ -/?#&=]`. That spelling reads as "not
 * these six" and means "not anything from space to slash", which quietly
 * rejects `user.name` and `svc+web` — legal role names, refused by a hyphen in
 * the wrong place. And written with escapes, not literal bytes: a source file
 * carrying a real NUL is invisible in review and stops `grep` treating it as
 * text at all.
 */
export const USERNAME = /^[^\u0000-\u001f\u007f/?#&=]{1,63}$/;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopback(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * An origin, and only an origin.
 *
 * A path or a query on the stored value would be spliced ahead of the
 * parameters the locator supplies, which is a way to make the final URL mean
 * something other than what the confirmation showed.
 */
export function assertOrigin(origin: string, allowRemote: boolean): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new HandoffConfigError(`\`${origin}\` is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HandoffConfigError(`\`${origin}\` must be http or https.`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new HandoffConfigError(
      `\`${origin}\` must be an origin only — scheme, host and port, with no path, query or fragment.`,
    );
  }
  if (!allowRemote && !isLoopback(origin)) {
    throw new HandoffConfigError(
      `\`${origin}\` is not loopback. A non-loopback origin can serve anything later, and DNS moves ` +
        'under a stable name, so it needs `--i-know-this-is-not-local` and prints a banner on every use.',
    );
  }
}

function assertMatches(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new HandoffConfigError(`\`${what}\` is not valid: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parses the file, refusing anything it does not fully understand.
 *
 * An unknown `preset` is a refusal rather than a skip: skipping would leave the
 * alias unbound, which reads to the user as "I never set that up" when what
 * actually happened is that their setup was silently discarded.
 */
export function parseHandoffConfig(
  raw: unknown,
  options: { allowRemote?: boolean } = {},
): HandoffConfigV1 {
  if (typeof raw !== 'object' || raw === null) {
    throw new HandoffConfigError('the handoff config is not an object.');
  }
  const source = raw as Record<string, unknown>;
  if (source['v'] !== HANDOFF_CONFIG_VERSION) {
    throw new HandoffConfigError(
      `the handoff config is version ${JSON.stringify(source['v'])}; ` +
        `this build writes version ${HANDOFF_CONFIG_VERSION}.`,
    );
  }
  const rawBindings = source['bindings'];
  if (typeof rawBindings !== 'object' || rawBindings === null) {
    throw new HandoffConfigError('`bindings` is missing.');
  }

  const bindings: Record<string, Binding> = {};
  for (const [alias, value] of Object.entries(rawBindings as Record<string, unknown>)) {
    assertMatches(alias, ALIAS, `alias ${alias}`);
    bindings[alias] = parseBinding(alias, value, options.allowRemote ?? false);
  }
  return { v: 1, bindings };
}
/**
 * An absolute path, on the platform this is running on.
 *
 * The test was `startsWith('/')`, which is what a POSIX absolute path looks
 * like and is not what a Windows one looks like. `D:\a\project` fails it, so
 * `handoff enable` wrote a grant the loader then refused as malformed, and the
 * feature could not work on Windows at all.
 *
 * This file had already been bitten by the same assumption once, for
 * `executable` — `store.test.ts` carries the note about a Windows psql path
 * being `C:\...` and the writer accepting what the reader would reject. The fix
 * then was to validate at write time; it should have been to stop asking a
 * POSIX question. `isAbsolute` is what all three checks should always have used.
 *
 * A UNC path is absolute to `isAbsolute` and stays allowed: a workspace on a
 * network share is a real thing, and refusing it here would be a new
 * restriction dressed as a portability fix.
 */
const absolute = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && isAbsolute(value);


function parseBinding(alias: string, value: unknown, allowRemote: boolean): Binding {
  if (typeof value !== 'object' || value === null) {
    throw new HandoffConfigError(`binding \`${alias}\` is not an object.`);
  }
  const b = value as Record<string, unknown>;
  const grants = parseGrants(alias, b['grants']);

  switch (b['preset']) {
    case 'adminer-url': {
      const origin = typeof b['origin'] === 'string' ? b['origin'] : '';
      assertOrigin(origin, allowRemote);
      return {
        preset: 'adminer-url',
        origin,
        server: assertMatches(b['server'], SERVER, `${alias}.server`),
        username: assertMatches(b['username'], USERNAME, `${alias}.username`),
        grants,
      };
    }
    case 'psql-service': {
      const executable = b['executable'];
      const realpath = b['realpath'];
      if (!absolute(executable)) {
        throw new HandoffConfigError(
          `\`${alias}.executable\` must be an absolute path resolved at enable time.`,
        );
      }
      if (!absolute(realpath)) {
        throw new HandoffConfigError(`\`${alias}.realpath\` must be an absolute path.`);
      }
      return {
        preset: 'psql-service',
        service: assertMatches(b['service'], SERVICE, `${alias}.service`),
        executable,
        realpath,
        grants,
      };
    }
    default:
      throw new HandoffConfigError(
        `binding \`${alias}\` names preset ${JSON.stringify(b['preset'])}, which this build does not know. ` +
          'Refusing rather than ignoring it: an ignored binding reads as one you never made.',
      );
  }
}

function parseGrants(alias: string, raw: unknown): WorkspaceGrant[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HandoffConfigError(`\`${alias}.grants\` is not a list.`);
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new HandoffConfigError(`\`${alias}.grants[${i}]\` is not an object.`);
    }
    const g = entry as Record<string, unknown>;
    if (!absolute(g['workspace'])) {
      throw new HandoffConfigError(`\`${alias}.grants[${i}].workspace\` must be an absolute path.`);
    }
    return {
      workspace: g['workspace'],
      approvedAt: typeof g['approvedAt'] === 'string' ? g['approvedAt'] : '',
      approvedBy: typeof g['approvedBy'] === 'string' ? g['approvedBy'] : '',
      policyVersion: typeof g['policyVersion'] === 'number' ? g['policyVersion'] : 0,
    };
  });
}

// ─── grants ───────────────────────────────────────────────────────────────────

/**
 * The full tuple a grant is keyed on.
 *
 * Every field that changes *what would happen* is in here. Deliberately not
 * `config.name` or `secrets.namespace`, both of which are repo-written — and
 * deliberately not a hash of the project config either, so editing a scenario,
 * an assertion or `maskColumns` re-asks nothing.
 */
export function grantKey(alias: string, binding: Binding, workspace: string): string {
  const target =
    binding.preset === 'adminer-url'
      ? [binding.origin, binding.server, binding.username]
      : [binding.service, binding.executable, binding.realpath];
  return JSON.stringify([workspace, alias, binding.preset, ...target, HANDOFF_POLICY_VERSION]);
}

/** Whether this binding may be used from this workspace, right now. */
export function isGranted(binding: Binding, workspace: string): boolean {
  return binding.grants.some(
    (grant) => grant.workspace === workspace && grant.policyVersion === HANDOFF_POLICY_VERSION,
  );
}

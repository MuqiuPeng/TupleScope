/**
 * The step between a workspace file and a run.
 *
 *     workspace config  +  credential context  +  secret store  →  resolved config
 *
 * `loadWorkspaceConfig` produces a config whose environment references are
 * expanded and whose secret references are still text. This turns the second
 * kind into values, and hands back the secrets it used so that anything
 * formatted later — a driver's error with the connection string inline, a stack
 * trace — can have them removed again.
 *
 * It walks every string in the config rather than a list of known fields. A
 * credential can go anywhere a string can, and a list of "fields that may hold
 * secrets" is a list that will be out of date the first time someone adds one.
 */

import {
  DEFAULT_CONTEXT,
  markedSecrets,
  markerPattern,
  redact,
  resolveParts,
  type CredentialContext,
  type Secret,
  type SecretStore,
} from '@statescope/secrets';
import { SECRET_NONCE, type ResolvedWorkspaceConfig } from './config.js';

export interface ResolveWorkspaceOptions {
  /** Absent when none could be opened; a reference then fails saying why. */
  store?: SecretStore | undefined;
  /** Why there is no store, carried into the failure so it can explain itself. */
  storeUnavailable?: string | undefined;
  context?: CredentialContext;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overridden only in tests; the real one is minted per process at load. */
  nonce?: string;
}

export interface ResolvedCredentials {
  config: ResolvedWorkspaceConfig;
  /** Everything the config actually used, for redaction. */
  secrets: ReadonlyArray<Secret>;
  /** Removes every resolved value from arbitrary text. */
  scrub(text: string): string;
}

/**
 * Every secret a config mentions, without reading any of them.
 *
 * Reads the markers the load pass left, not the original syntax — so a
 * reference that came from an environment variable's value, or from text the
 * `$${` escape was protecting, is correctly not one.
 */
export function secretsReferencedBy(config: unknown, nonce: string = SECRET_NONCE): string[] {
  const found = new Set<string>();
  walk(config, (text) => {
    for (const name of markedSecrets(text, nonce)) found.add(name);
    return text;
  });
  return [...found].sort();
}

export async function resolveWorkspaceSecrets(
  config: ResolvedWorkspaceConfig,
  options: ResolveWorkspaceOptions = {},
): Promise<ResolvedCredentials> {
  const used = new Map<string, Secret>();
  const env = options.env ?? process.env;
  const context = options.context ?? DEFAULT_CONTEXT;

  const nonce = options.nonce ?? SECRET_NONCE;
  const resolved = await walkAsync(config, async (text, path) => {
    const names = markedSecrets(text, nonce);
    if (names.length === 0) return text;
    // Markers only. The text between them is literal by construction — it was
    // already produced by the load pass — so it is never parsed again.
    const out = await resolveParts(
      names.map((name) => ({ kind: 'secret' as const, name })),
      {
        env,
        ...(options.store ? { store: options.store } : {}),
        ...(options.storeUnavailable ? { storeUnavailable: options.storeUnavailable } : {}),
        context,
        where: `\`${path.join('.')}\``,
      },
    );
    for (const secret of out.secrets) used.set(secret.name, secret);
    return text.replace(markerPattern(nonce), (_, name: string) => {
      const secret = used.get(name);
      if (!secret) throw new Error(`internal: no value resolved for \`${name}\``);
      return secret.reveal();
    });
  });

  const secrets = [...used.values()];
  return {
    config: resolved as ResolvedWorkspaceConfig,
    secrets,
    scrub: (text: string) => redact(text, secrets),
  };
}

/**
 * Refuses a config that still holds an unresolved reference.
 *
 * The whole hazard of resolving in a separate pass is that something skips it:
 * `${secret:alice_token}` reaching an HTTP header would be sent to the API as
 * those twenty-two characters, and the failure would look like an
 * authentication problem rather than a missing step. This turns it into a
 * sentence naming the field.
 */
export function assertResolved(config: unknown, nonce: string = SECRET_NONCE): void {
  const unresolved: string[] = [];
  walk(config, (text, path) => {
    if (markedSecrets(text, nonce).length > 0) unresolved.push(path.join('.'));
    return text;
  });
  if (unresolved.length === 0) return;
  throw new Error(
    `Secret references reached the runtime unresolved: ${unresolved.join(', ')}. ` +
      `Something used this workspace without calling resolveWorkspaceSecrets() first — the ` +
      `reference would otherwise be sent verbatim.`,
  );
}

type Visit = (text: string, path: ReadonlyArray<string>) => string;
type VisitAsync = (text: string, path: ReadonlyArray<string>) => Promise<string>;

function walk(value: unknown, visit: Visit, path: ReadonlyArray<string> = []): unknown {
  if (typeof value === 'string') return visit(value, path);
  if (Array.isArray(value)) return value.map((item, i) => walk(item, visit, [...path, String(i)]));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, visit, [...path, k])]),
    );
  }
  return value;
}

async function walkAsync(
  value: unknown,
  visit: VisitAsync,
  path: ReadonlyArray<string> = [],
): Promise<unknown> {
  if (typeof value === 'string') return visit(value, path);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const [i, item] of value.entries()) out.push(await walkAsync(item, visit, [...path, String(i)]));
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = await walkAsync(v, visit, [...path, k]);
    }
    return out;
  }
  return value;
}

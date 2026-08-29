/**
 * Turning what a workspace file says into what a run actually uses.
 *
 * The whole point of the reference model is that these are two different
 * things. The file — the one that is committed — names credentials. A run
 * resolves those names, and the resolution depends on where it is happening and
 * as whom.
 *
 *   workspace config  +  credential context  +  secret store  →  resolved value
 *
 * ## The order, stated so it cannot drift
 *
 * The *kind* of reference picks its lane first, and the lanes never cross:
 *
 *   `${VAR}`          the environment, then the reference's own `:-default`
 *   `${secret:name}`  an explicit override, then the profile's binding for
 *                     `name`, then the store
 *
 * `${secret:name}` never reads environment variable `name`, and `${VAR}` never
 * reads the store. That is not an oversight to be smoothed over later: once a
 * value can arrive from either place, nobody can answer "where did this
 * credential come from", and the answer is the only reason to have the feature.
 *
 * ## Logical name versus stored id
 *
 * A reference names a *role* — `customer_token` — and a binding says which
 * stored credential plays it. With no binding the two are the same string, and
 * today there are no bindings, so they always are. The indirection exists now
 * because it is the thing that cannot be added later without changing what
 * every existing workspace file means:
 *
 *     ${secret:customer_token}
 *              ↓  bindings[customer_token] ?? 'customer_token'
 *           alice_customer_token
 *              ↓  store.get(...)
 *           the value
 */

import { parseTemplate, type Part } from './reference.js';
import { Secret } from './secret.js';
import { SecretNotConfigured, type SecretId, type SecretStore } from './store.js';

/**
 * Who a run is resolving credentials as.
 *
 * `profile` is reserved and unused: there is exactly one, it is implicit, and
 * nothing selects it. It is here because the alternative — adding it later —
 * would mean deciding then whether an existing file's `${secret:x}` had always
 * meant "the profile's x" or "the stored x", and either answer breaks somebody.
 */
export interface CredentialContext {
  /** Reserved. Always `'default'` today; nothing reads it yet. */
  readonly profile?: string;
  /** Logical name → stored id. Empty today. */
  readonly bindings: Readonly<Record<string, SecretId>>;
  /**
   * Values supplied for this run alone, highest precedence, never persisted.
   * Reserved for a future `--secret name=value`; empty today.
   */
  readonly overrides?: Readonly<Record<string, string>>;
}

export const DEFAULT_CONTEXT: CredentialContext = { profile: 'default', bindings: {} };

/** The stored id a logical name resolves to. */
export function secretIdFor(name: string, context: CredentialContext): SecretId {
  return context.bindings[name] ?? name;
}

export interface ResolveOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Absent when no store could be opened; a secret reference then fails with why. */
  store?: SecretStore | undefined;
  context?: CredentialContext;
  /** For error messages: which config key this string came from. */
  where: string;
  /** Why there is no store, so a failure can say so rather than "not configured". */
  storeUnavailable?: string | undefined;
}

/**
 * A resolved string, plus the secrets that went into it.
 *
 * The secrets come back so a caller can redact them out of anything it later
 * formats — a driver's error message with the connection string inline, a
 * stack trace — which is the only defence against text somebody else built.
 */
export interface Resolved {
  value: string;
  secrets: ReadonlyArray<Secret>;
}

export async function resolveTemplate(source: string, options: ResolveOptions): Promise<Resolved> {
  return resolveParts(parseTemplate(source), options);
}

export async function resolveParts(
  parts: ReadonlyArray<Part>,
  options: ResolveOptions,
): Promise<Resolved> {
  const context = options.context ?? DEFAULT_CONTEXT;
  const used: Secret[] = [];
  let value = '';

  for (const part of parts) {
    if (part.kind === 'literal') {
      value += part.text;
      continue;
    }
    if (part.kind === 'env') {
      const found = options.env[part.name];
      if (found !== undefined) {
        value += found;
        continue;
      }
      if (part.fallback !== undefined) {
        value += part.fallback;
        continue;
      }
      throw new Error(
        `${options.where} refers to \${${part.name}}, which is not set. ` +
          `Set it, or give it a default: \${${part.name}:-something}.`,
      );
    }

    const secret = await resolveSecret(part.name, context, options);
    used.push(secret);
    value += secret.reveal();
  }

  return { value, secrets: used };
}

async function resolveSecret(
  name: string,
  context: CredentialContext,
  options: ResolveOptions,
): Promise<Secret> {
  // 1. An override for this run alone.
  const override = context.overrides?.[name];
  if (override !== undefined) return new Secret(override, name);

  // 2. The profile's binding, if any, decides which stored id to ask for.
  const id = secretIdFor(name, context);

  // 3. The store — and only the store. Never the environment.
  if (!options.store) {
    throw new Error(
      `${options.where} needs the secret \`${name}\`, and no secret store is available. ` +
        `${options.storeUnavailable ?? ''}\n` +
        `\`\${secret:…}\` reads only the secret store — it will not fall back to an ` +
        `environment variable, because a credential whose origin depends on what happened to ` +
        `be exported cannot be reasoned about. To use the environment deliberately, write ` +
        `\`\${SOME_VAR}\` instead.`,
    );
  }
  const found = await options.store.get(id);
  if (!found) throw new SecretNotConfigured(name, id, options.where);
  return found;
}

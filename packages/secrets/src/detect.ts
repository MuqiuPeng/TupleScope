/**
 * Choosing a credential store, and refusing to invent one.
 *
 * There is exactly one automatic choice per platform: the operating system's
 * own store. When it cannot be used, this fails with the reason and the
 * alternative. It does **not** fall back to a file.
 *
 * That refusal is the feature. The whole point of `${secret:…}` is that the
 * credential is not in a file that gets committed, and a tool that responds to
 * a missing keyring by writing `.statescope/secrets.json` has kept the syntax
 * and thrown away the promise. A file-backed store may exist, but only where
 * someone chose it on purpose and was told what it is worth.
 */

import { SecretServiceStore } from './linux.js';
import { MacOSKeychain } from './macos.js';
import { SecretStoreUnavailable, type Namespace, type SecretStore } from './store.js';
import { WindowsCredentialManager } from './windows.js';

export type StoreKind = 'os';

export interface OpenOptions {
  /**
   * Which workspace's credentials this store holds.
   *
   * Required, and deliberately not defaulted: a store with no namespace would
   * put two projects' `api_token` in one slot, and the collision is invisible —
   * the second `set` succeeds and prints what a first-time store prints.
   */
  namespace: Namespace;
  /** Overridden in tests; the real one is `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * The platform store, or a `SecretStoreUnavailable` naming why not.
 *
 * Callers that can continue without secrets — `config check`, a workspace with
 * no references — should catch it and carry the reason, so a later failure can
 * say *why* there was no store rather than merely that a secret was missing.
 */
export async function openSecretStore(options: OpenOptions): Promise<SecretStore> {
  const platform = options.platform ?? process.platform;
  const namespace = options.namespace;
  switch (platform) {
    case 'darwin':
      return MacOSKeychain.probe(namespace);
    case 'win32':
      return WindowsCredentialManager.probe(namespace);
    case 'linux':
      return SecretServiceStore.probe(namespace);
    default:
      throw new SecretStoreUnavailable(
        `there is no credential store for ${platform}`,
        'Use environment variables with `${VAR}`.',
      );
  }
}

/** The store if there is one, and otherwise why there is not — never a substitute. */
export async function tryOpenSecretStore(
  options: OpenOptions,
): Promise<{ store: SecretStore } | { store: undefined; reason: string }> {
  try {
    return { store: await openSecretStore(options) };
  } catch (error) {
    if (error instanceof SecretStoreUnavailable) {
      return { store: undefined, reason: `${error.reason}. ${error.remedy}` };
    }
    throw error;
  }
}

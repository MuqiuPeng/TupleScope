/**
 * A workspace file, loaded, with every credential reference turned into a value.
 *
 * This is the one door. It used not to be: the CLI loaded the file and resolved
 * its references inline, and the HTTP runtime and MCP each called
 * `loadWorkspaceConfig` and then `openWorkspace`, skipping the step in between.
 * A workspace with its password in the keychain — the setup the README
 * recommends — ran under `tuplescope run` and died at `pnpm start` with
 * "Secret references reached the runtime unresolved". The guard did its job;
 * what was missing was a place for the step that all three callers would find.
 *
 * The store is opened only when the file refers to a secret, so a workspace
 * with none never touches the keychain and never prompts.
 */

import { tryOpenSecretStore, type Namespace, type SecretStore } from '@tuplescope/secrets';
import { loadWorkspaceConfig, namespaceOf, type LoadOptions } from './config.js';
import {
  resolveWorkspaceSecrets,
  secretsReferencedBy,
  type ResolvedCredentials,
} from './credentials.js';

/**
 * The platform store, or why there is none. Tests supply their own; the CLI
 * wraps the platform one so a failed read names its secret
 * (apps/cli/src/store-read.ts).
 */
export type StoreOpener = (
  namespace: Namespace,
) => Promise<{ store: SecretStore } | { store: undefined; reason: string }>;

export interface LoadWorkspaceOptions extends LoadOptions {
  openStore?: StoreOpener;
}

const platformStore: StoreOpener = (namespace) => tryOpenSecretStore({ namespace });

export async function loadWorkspace(options: LoadWorkspaceOptions = {}): Promise<ResolvedCredentials> {
  const { openStore = platformStore, ...load } = options;
  const loaded = await loadWorkspaceConfig(load);

  const opened = secretsReferencedBy(loaded).length > 0 ? await openStore(namespaceOf(loaded)) : undefined;
  return resolveWorkspaceSecrets(loaded, {
    ...(load.env ? { env: load.env } : {}),
    ...(opened?.store ? { store: opened.store } : {}),
    // Carried into the failure so it can say *why* there was no store, rather
    // than merely that a secret was missing.
    ...(opened && !opened.store ? { storeUnavailable: opened.reason } : {}),
  });
}

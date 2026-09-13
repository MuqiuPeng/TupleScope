/**
 * A secret the store has but cannot hand back, attributed to its id.
 *
 * The store's own sentence for an item it did not write is a good one —
 * "was not written by TupleScope, so its contents cannot be read reliably.
 * Overwrite it with `tuplescope secret set handmade`" — and it reached the user
 * as an uncaught `Error` with a ten-line stack trace and exit 2, from `ls` and
 * from `status`, which stopped printing its table. It is a plain `Error`, so
 * nothing above could tell it from a bug.
 *
 * Wrapping the platform store's `get` is what lets the CLI say which secret it
 * was: `status` marks that line, and every other command prints the sentence
 * and exits 4 — a workspace that will not load.
 */

import { tryOpenSecretStore, type SecretStore } from '@tuplescope/secrets';
import type { StoreOpener } from '@tuplescope/workspace';

export class SecretUnreadable extends Error {
  constructor(
    readonly id: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'SecretUnreadable';
  }
}

/** The same store, with a failed read carrying the id it was for. */
export function attributingReads(store: SecretStore): SecretStore {
  return {
    description: store.description,
    has: (id) => store.has(id),
    get: async (id) => {
      try {
        return await store.get(id);
      } catch (error) {
        throw new SecretUnreadable(id, error instanceof Error ? error.message : String(error));
      }
    },
    set: (id, value) => store.set(id, value),
    delete: (id) => store.delete(id),
    list: () => store.list(),
  };
}

/** The platform store `loadWorkspace` would open, with reads attributed. */
export const attributingStore: StoreOpener = async (namespace) => {
  const opened = await tryOpenSecretStore({ namespace });
  return opened.store ? { store: attributingReads(opened.store) } : opened;
};

/**
 * The engine registry: the single place a capture engine's name is bound to the
 * thing that implements it.
 *
 * A lookup rather than a branch, and that is the point. A `switch` on the
 * engine name here would be indistinguishable, to a reader or to a grep, from
 * the `if (captureMethod === 'wal')` that `packages/core/src/abstraction.test.ts`
 * exists to forbid — and a rule with one blessed exception is a rule on its way
 * out. With a map there is no comparison to make an exception for: adding an
 * engine adds a key, and nothing anywhere else learns its name.
 */

import type { CaptureMethod, DatabaseAdapter, CaptureScope, TableScope } from '@statescope/core';
import { MvccPostgresAdapter } from './mvcc-adapter.js';
import { SnapshotPostgresAdapter } from './snapshot-adapter.js';
import { WalPostgresAdapter } from './wal-adapter.js';

export interface EngineOptions {
  connectionString: string;
  maskColumns?: ReadonlyArray<string>;
}

/**
 * What a workspace needs beyond the contract: the ability to build a scope
 * covering the whole schema, which is a Postgres concern rather than a
 * capture-engine one.
 */
export type PostgresAdapter = DatabaseAdapter & {
  fullScope(overrides?: Partial<TableScope>): Promise<CaptureScope>;
};

export const ENGINES = {
  'mvcc-xmin': (options: EngineOptions) => new MvccPostgresAdapter(options),
  'snapshot-diff': (options: EngineOptions) => new SnapshotPostgresAdapter(options),
  wal: (options: EngineOptions) => new WalPostgresAdapter(options),
} satisfies Partial<Record<CaptureMethod, (options: EngineOptions) => PostgresAdapter>>;

export type EngineName = keyof typeof ENGINES;

export const ENGINE_NAMES = Object.keys(ENGINES) as EngineName[];

export const DEFAULT_ENGINE: EngineName = 'mvcc-xmin';

export function createAdapter(name: EngineName | undefined, options: EngineOptions): PostgresAdapter {
  return ENGINES[name ?? DEFAULT_ENGINE](options);
}

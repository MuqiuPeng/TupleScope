/**
 * Run history: one JSON file per run, and no index.
 *
 * It ships for one reason. `--from` and `--only` reuse the variables an earlier
 * run captured — including `{{run}}`, without which a "replay" sends a
 * genuinely new request — and until now those variables lived in the runtime's
 * process memory, which a CLI invocation does not share. A named run id turns
 * un-inspectable process state into something the report can point at.
 *
 * What is stored is the envelope, not a second schema invented for disk. It
 * already carries the policy the verdict was reached under, the producer and
 * the exit code, so `runs show --json` prints the file verbatim and a stored
 * run reads exactly like a fresh one.
 *
 * No index file, because `Run.id` is prefixed with a base36 millisecond stamp
 * and therefore sorts lexicographically: `readdir().sort()` *is* the index, and
 * an index is one more thing that can disagree with the directory it describes.
 *
 * Nothing new is exposed by writing this down. Values are masked at capture,
 * before they leave the adapter, so the file holds exactly what the UI already
 * held in memory.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The stored artifact: whatever the report layer produced for a single run. */
export interface StoredRun {
  run: { id: string; scenarioId?: string; datasetId?: string; coverage?: string; startedAt?: string };
  [key: string]: unknown;
}

export interface StoredRunSummary {
  id: string;
  scenarioId: string;
  datasetId: string;
  coverage: string;
  outcome: string;
  startedAt: string;
}

export interface RunStore {
  save(report: StoredRun): Promise<void>;
  get(id: string): Promise<StoredRun | undefined>;
  /** The newest matching run. `last` in the CLI resolves through this. */
  latest(filter?: {
    scenarioId?: string;
    datasetId?: string;
    coverage?: 'full';
  }): Promise<StoredRun | undefined>;
  list(limit: number): Promise<ReadonlyArray<StoredRunSummary>>;
  prune(keep: number): Promise<void>;
  readonly dir: string;
}

export interface StoreOptions {
  /** How many runs to retain. `0` disables the store entirely. */
  keep?: number;
}

const DEFAULT_KEEP = 50;

export function openStore(dir: string, options: StoreOptions = {}): RunStore {
  const keep = options.keep ?? DEFAULT_KEEP;

  const ids = async (): Promise<string[]> => {
    try {
      // Lexicographic order is chronological because the id starts with a
      // base36 millisecond stamp. Newest first.
      return (await readdir(dir))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse()
        .map((name) => name.slice(0, -'.json'.length));
    } catch {
      return [];
    }
  };

  const read = async (id: string): Promise<StoredRun | undefined> => {
    try {
      return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as StoredRun;
    } catch {
      // A truncated or hand-edited file is not worth failing a run over; it is
      // history, and the run that matters is the one happening now.
      return undefined;
    }
  };

  const store: RunStore = {
    dir,

    async save(report) {
      if (keep === 0) return;
      const id = report.run.id;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const final = join(dir, `${id}.json`);
      const temp = `${final}.tmp`;
      // Written then renamed: a reader must never see half a file, and a run
      // interrupted mid-write must not leave one behind.
      await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, final);
      await store.prune(keep);
    },

    get: read,

    async latest(filter) {
      for (const id of await ids()) {
        const stored = await read(id);
        if (!stored) continue;
        if (filter?.scenarioId && stored.run.scenarioId !== filter.scenarioId) continue;
        if (filter?.datasetId && stored.run.datasetId !== filter.datasetId) continue;
        // A partial run's variables are a mixture of carried and fresh, so
        // continuing from one compounds whatever was already ambiguous.
        if (filter?.coverage && stored.run.coverage !== filter.coverage) continue;
        return stored;
      }
      return undefined;
    },

    async list(limit) {
      const out: StoredRunSummary[] = [];
      for (const id of await ids()) {
        if (out.length >= limit) break;
        const stored = await read(id);
        if (!stored) continue;
        const verdict = (stored['verdict'] ?? {}) as { outcome?: string };
        out.push({
          id,
          scenarioId: stored.run.scenarioId ?? '?',
          datasetId: stored.run.datasetId ?? '?',
          coverage: stored.run.coverage ?? '?',
          outcome: verdict.outcome ?? '?',
          startedAt: stored.run.startedAt ?? '',
        });
      }
      return out;
    },

    async prune(count) {
      const all = await ids();
      await Promise.all(
        all.slice(count).map((id) => rm(join(dir, `${id}.json`), { force: true })),
      );
    },
  };

  return store;
}

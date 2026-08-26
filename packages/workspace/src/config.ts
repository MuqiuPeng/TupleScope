/**
 * The workspace file: what StateScope points at, and how it is found.
 *
 * StateScope's entire interface to the outside world is two strings — an HTTP
 * base URL and a database connection string. It deliberately knows nothing
 * about how either of those came to exist: no process supervisor, no container
 * runtime, no service registry. Whoever brings the backend up supplies the
 * values, through the file or through the environment.
 *
 * That is not minimalism for its own sake. A tool that resolved its target
 * through a supervisor would resolve it one way on a developer's machine and
 * another way in CI, and a scenario that passes in one place and fails in the
 * other — for reasons invisible in the scenario — is the exact failure this
 * product exists to prevent.
 */

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import YAML from 'yaml';

export class WorkspaceConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = 'WorkspaceConfigError';
  }
}

export interface Identity {
  id: string;
  header: { name: string; value: string };
}

/** The file as written. Paths may be relative; `${VAR}` may be unexpanded. */
export interface WorkspaceConfig {
  name: string;
  baseUrl: string;
  database: { connectionString: string };
  scenariosDir: string;
  identities?: Identity[];
  ignoreColumns?: string[];
  maskColumns?: string[];
  /** Endpoint that wipes and reseeds, used by datasets declaring `resetFirst`. */
  resetUrl?: string;
  /** Idle window watched before each run to detect writers other than the scenario. */
  baselineWindowMs?: number;
}

/** The same config after resolution: absolute paths, every `${VAR}` expanded. */
export interface ResolvedWorkspaceConfig extends WorkspaceConfig {
  /** Absolute. */
  scenariosDir: string;
  /** Where this came from, so every error can name it. */
  readonly configFile: string;
  /** The directory relative paths were resolved against. */
  readonly configDir: string;
}

// ─── discovery ────────────────────────────────────────────────────────────────

const FILE_NAME = 'statescope.yaml';

export interface DiscoveryOptions {
  /** Explicit path, highest precedence. */
  configPath?: string | undefined;
  /** Where to start walking up from. Defaults to the process's cwd. */
  from?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Finds the workspace file: explicit path, then `STATESCOPE_CONFIG`, then a
 * walk up from the working directory.
 *
 * Resolving relative to the *installed location of the code* — which is what an
 * earlier version did — breaks the moment the package is run from anywhere but
 * a checkout: under `npx` it resolves into the pnpm store. The working
 * directory is the only anchor that means what the user expects.
 */
export async function findWorkspaceConfig(options: DiscoveryOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = options.configPath ?? env['STATESCOPE_CONFIG'];
  if (explicit) {
    const path = resolve(explicit);
    if (!(await readable(path))) {
      throw new WorkspaceConfigError(`no such workspace file: ${path}`);
    }
    return path;
  }

  const searched: string[] = [];
  let dir = resolve(options.from ?? process.cwd());
  for (;;) {
    const candidate = join(dir, FILE_NAME);
    searched.push(candidate);
    if (await readable(candidate)) return candidate;
    // Stop at the repository root: past it we are searching someone else's
    // directories, and a stray statescope.yaml in a parent would be a
    // surprising thing to silently pick up.
    if (await readable(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new WorkspaceConfigError(
    `no ${FILE_NAME} found. Looked in:\n` +
      searched.map((p) => `  ${p}`).join('\n') +
      `\n\nCopy statescope.example.yaml to ${FILE_NAME}, or pass --config.`,
  );
}

async function readable(path: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises');
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ─── ${VAR} interpolation ─────────────────────────────────────────────────────

/**
 * Expands `${VAR}` and `${VAR:-default}` in every string, after the YAML parse.
 *
 * After, not before: a value containing a colon or a newline would produce
 * invalid YAML if substituted into the source text, and the failure would point
 * at a line the user did not write. `$${` is a literal `${`.
 *
 * This is how a workspace file stays portable across a laptop and CI without
 * StateScope knowing anything about either. It is also the reason there is no
 * service-discovery integration: whoever knows the real port can put it in the
 * environment.
 */
const PLACEHOLDER = /\$(\$)?\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  path: ReadonlyArray<string> = [],
): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (match, escaped: string | undefined, name: string, fallback: string | undefined) => {
      if (escaped) return match.slice(1); // `$${VAR}` -> `${VAR}`
      const found = env[name];
      if (found !== undefined) return found;
      if (fallback !== undefined) return fallback;
      throw new WorkspaceConfigError(
        `\`${path.join('.') || '(root)'}\` refers to \${${name}}, which is not set. ` +
          `Set it, or give it a default: \${${name}:-something}.`,
      );
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolate(item, env, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        interpolate(item, env, [...path, key]),
      ]),
    );
  }
  return value;
}

// ─── loading ──────────────────────────────────────────────────────────────────

const KNOWN_KEYS = new Set([
  'name',
  'baseUrl',
  'database',
  'scenariosDir',
  'identities',
  'ignoreColumns',
  'maskColumns',
  'resetUrl',
  'baselineWindowMs',
]);

export interface LoadOptions extends DiscoveryOptions {
  /** Overrides `process.env`, for tests and for a caller with its own env. */
  env?: Readonly<Record<string, string | undefined>>;
}

export async function loadWorkspaceConfig(
  options: LoadOptions = {},
): Promise<ResolvedWorkspaceConfig> {
  const file = await findWorkspaceConfig(options);
  const env = options.env ?? process.env;

  let parsed: unknown;
  try {
    parsed = YAML.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkspaceConfigError(
      error instanceof Error ? error.message : String(error),
      file,
    );
  }

  let expanded: unknown;
  try {
    expanded = interpolate(parsed, env);
  } catch (error) {
    if (error instanceof WorkspaceConfigError) throw new WorkspaceConfigError(error.message, file);
    throw error;
  }

  return validate(expanded, file);
}

/** Parses an already-read document. Used by tests and by anything holding text. */
export function parseWorkspaceConfig(
  source: string,
  file: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedWorkspaceConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new WorkspaceConfigError(error instanceof Error ? error.message : String(error), file);
  }
  return validate(interpolate(parsed, env), file);
}

function validate(value: unknown, file: string): ResolvedWorkspaceConfig {
  const fail = (message: string): never => {
    throw new WorkspaceConfigError(message, file);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('not a YAML mapping');
  }
  const doc = value as Record<string, unknown>;

  // An unknown key is nearly always a typo, and silently ignoring it means the
  // setting the user thought they applied simply did not happen.
  for (const key of Object.keys(doc)) {
    if (KNOWN_KEYS.has(key)) continue;
    const suggestion = nearest(key, [...KNOWN_KEYS]);
    return fail(`unknown key \`${key}\`${suggestion ? ` — did you mean \`${suggestion}\`?` : ''}`);
  }

  for (const key of ['name', 'baseUrl', 'scenariosDir'] as const) {
    if (typeof doc[key] !== 'string' || !(doc[key] as string).trim()) {
      return fail(`\`${key}\` is required and must be a non-empty string`);
    }
  }

  const baseUrl = doc['baseUrl'] as string;
  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    return fail(`\`baseUrl\` is not a URL: ${baseUrl}`);
  }

  const database = doc['database'];
  if (
    !database ||
    typeof database !== 'object' ||
    typeof (database as { connectionString?: unknown }).connectionString !== 'string'
  ) {
    return fail('`database.connectionString` is required');
  }

  const identities = doc['identities'];
  if (identities !== undefined) {
    if (!Array.isArray(identities)) return fail('`identities` must be a list');
    const seen = new Set<string>();
    for (const [index, entry] of identities.entries()) {
      const identity = entry as Partial<Identity>;
      if (typeof identity?.id !== 'string' || !identity.id) {
        return fail(`identity ${index} has no id`);
      }
      if (seen.has(identity.id)) return fail(`two identities share the id \`${identity.id}\``);
      seen.add(identity.id);
      if (
        typeof identity.header?.name !== 'string' ||
        typeof identity.header?.value !== 'string'
      ) {
        return fail(`identity \`${identity.id}\` needs header.name and header.value`);
      }
    }
  }

  for (const key of ['ignoreColumns', 'maskColumns'] as const) {
    const list = doc[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((c) => typeof c !== 'string')) {
      return fail(`\`${key}\` must be a list of column names`);
    }
  }

  const window = doc['baselineWindowMs'];
  if (window !== undefined && (typeof window !== 'number' || window < 0)) {
    return fail('`baselineWindowMs` must be a non-negative number of milliseconds');
  }

  const configDir = dirname(file);
  const scenariosDir = doc['scenariosDir'] as string;

  return {
    ...(doc as unknown as WorkspaceConfig),
    scenariosDir: isAbsolute(scenariosDir) ? scenariosDir : resolve(configDir, scenariosDir),
    configFile: file,
    configDir,
  };
}

/** Cheap edit distance, only to turn `databse` into a useful suggestion. */
function nearest(input: string, candidates: ReadonlyArray<string>): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(input.toLowerCase(), name.toLowerCase());
    if (!best || distance < best.distance) best = { name, distance };
  }
  // Beyond a third of the word, a "suggestion" is noise.
  return best && best.distance <= Math.max(1, Math.floor(input.length / 3)) ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

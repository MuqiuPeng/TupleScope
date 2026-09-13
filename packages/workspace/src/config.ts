/**
 * The workspace file: what TupleScope points at, and how it is found.
 *
 * TupleScope's entire interface to the outside world is two strings — an HTTP
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
import { parseTemplate, ReferenceSyntaxError, secretMarker } from '@tuplescope/secrets';
import { randomBytes } from 'node:crypto';

/**
 * Minted once per process, and never written anywhere.
 *
 * It is what separates a secret reference the *file* contained from one that
 * appeared in an environment variable's value or survived the `$${` escape.
 * Both of those reached the keychain before this existed.
 */
const SECRET_NONCE = randomBytes(16).toString('hex');

export { SECRET_NONCE };
import { ENGINE_NAMES, type EngineName } from '@tuplescope/db-postgres';
import { NAMESPACE, namespaceFor, type Namespace } from '@tuplescope/secrets';

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

/**
 * A chart of one or more columns across the run, drawn beside the diff.
 *
 * The repository chooses what a panel is *about* — a title, a unit, and named
 * expressions in the language assertions already use. It contributes no code and
 * no rendering: the host evaluates the sources with `seriesFor` and draws them
 * in its own palette. See docs/panel-mods-design.md §13 for why it is this way
 * round and not a plugin.
 */
export interface PanelSpec {
  title: string;
  /** Printed beside the axis. Labels only ever describe. */
  unit?: string;
  /**
   * Series name → expression, which must select a **column**.
   *
   * `after(updated(stock, sku = "X").on_hand)`, not `single(...)`: `single()`
   * throws when a step did not touch the row, which is the ordinary case for
   * most steps and not an error. A column selector answers with an empty list,
   * which is the distinction a series needs.
   */
  sources: Record<string, string>;
}

/** The file as written. Paths may be relative; `${VAR}` may be unexpanded. */
export interface WorkspaceConfig {
  name: string;
  baseUrl: string;
  database: { connectionString: string };
  scenariosDir: string;
  identities?: Identity[];
  /** Charts drawn beside the diff. Inert: names and expressions, never code. */
  panels?: PanelSpec[];
  ignoreColumns?: string[];
  maskColumns?: string[];
  /** Endpoint that wipes and reseeds, used by datasets declaring `resetFirst`. */
  resetUrl?: string;
  /** Idle window watched before each run to detect writers other than the scenario. */
  baselineWindowMs?: number;
  /**
   * Which capture engine observes the database.
   *
   * `mvcc-xmin` is the default and the one to want: it detects a *write* rather
   * than a value difference, which is what an idempotency assertion needs, and
   * it reads almost nothing. `snapshot-diff` reads every watched table twice per
   * step and cannot see a rewrite to identical values — assertions that need
   * that come back undecided rather than wrong — but it holds no transaction
   * open, which matters against a database where a long-lived REPEATABLE READ
   * is unwelcome.
   */
  engine?: EngineName;
  /**
   * Which slot in the machine's credential store this workspace's secrets use.
   *
   * Defaults to a slug of `name`, which is already required and already
   * committed — so every workspace gets one without an edit. Set it explicitly
   * when two projects share a name, or when renaming the workspace should not
   * orphan its stored credentials.
   */
  secrets?: { namespace?: string };
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

const FILE_NAME = 'tuplescope.yaml';

export interface DiscoveryOptions {
  /** Explicit path, highest precedence. */
  configPath?: string | undefined;
  /** Where to start walking up from. Defaults to the process's cwd. */
  from?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Finds the workspace file: explicit path, then `TUPLESCOPE_CONFIG`, then a
 * walk up from the working directory.
 *
 * Resolving relative to the *installed location of the code* — which is what an
 * earlier version did — breaks the moment the package is run from anywhere but
 * a checkout: under `npx` it resolves into the pnpm store. The working
 * directory is the only anchor that means what the user expects.
 */
export async function findWorkspaceConfig(options: DiscoveryOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const explicit = options.configPath ?? env['TUPLESCOPE_CONFIG'];
  if (explicit) {
    const path = resolve(explicit);
    if (!(await readable(path))) {
      // Which knob named it, and what to turn. This used to be the bare path,
      // and through MCP — where the only visible input is an environment
      // variable the agent did not set — nothing said where it came from.
      throw new WorkspaceConfigError(
        options.configPath
          ? `no such workspace file: ${path} (named by --config)\n\n` +
              'Point --config at an existing tuplescope.yaml, or leave it out to use ' +
              'TUPLESCOPE_CONFIG or the nearest tuplescope.yaml above the working directory.'
          : `no such workspace file: ${path} (named by TUPLESCOPE_CONFIG)\n\n` +
              'Point TUPLESCOPE_CONFIG at an existing tuplescope.yaml, pass --config <path>, ' +
              'or unset it to use the nearest tuplescope.yaml above the working directory.',
      );
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
    // directories, and a stray tuplescope.yaml in a parent would be a
    // surprising thing to silently pick up.
    if (await readable(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new WorkspaceConfigError(
    `no ${FILE_NAME} found. Looked in:\n` +
      searched.map((p) => `  ${p}`).join('\n') +
      // Both knobs, not just the flag: a server started by an MCP client takes
      // its environment from the client's config, and the flag alone sent an
      // agent looking for an argument it had no way to pass.
      `\n\nCopy tuplescope.example.yaml to ${FILE_NAME}, pass --config <path>, ` +
      `or set TUPLESCOPE_CONFIG=<path>.`,
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
 * TupleScope knowing anything about either. It is also the reason there is no
 * service-discovery integration: whoever knows the real port can put it in the
 * environment.
 */

/**
 * Expands environment references, and leaves secret references for later.
 *
 * Secrets cannot be resolved here: reading a credential store means talking to
 * another process, and this runs before the config has even been validated. So
 * `\${secret:…}` survives this pass untouched and is resolved by `openWorkspace`,
 * which is the moment a run actually needs a value.
 *
 * What this pass *does* do for them is check the syntax. A reference that made
 * it through as literal text would be sent to the API as those characters — and
 * before the grammar was shared, `\${secret:x}` matched no pattern here and did
 * exactly that. Anything `\${…}`-shaped is now either recognised or an error.
 */
export function interpolate(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
  path: ReadonlyArray<string> = [],
  nonce: string = SECRET_NONCE,
): unknown {
  if (typeof value === 'string') {
    const where = `\`${path.join('.') || '(root)'}\``;
    let parts;
    try {
      parts = parseTemplate(value);
    } catch (error) {
      if (error instanceof ReferenceSyntaxError) {
        throw new WorkspaceConfigError(`${where}: ${error.message}`);
      }
      throw error;
    }
    return parts
      .map((part) => {
        if (part.kind === 'literal') return part.text;
        if (part.kind === 'secret') {
          // A marker, not the original text. Emitting `${secret:…}` here meant
          // the later pass re-read it — which defeated the `$${` escape and
          // let an environment variable whose value happened to look like a
          // reference become one.
          return secretMarker(nonce, part.name);
        }
        const found = env[part.name];
        if (found !== undefined) return found;
        if (part.fallback !== undefined) return part.fallback;
        throw new WorkspaceConfigError(
          `${where} refers to \${${part.name}}, which is not set. ` +
            `Set it, or give it a default: \${${part.name}:-something}.`,
        );
      })
      .join('');
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolate(item, env, [...path, String(index)], nonce));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        interpolate(item, env, [...path, key], nonce),
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
  'panels',
  'resetUrl',
  'baselineWindowMs',
  'engine',
  'secrets',
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

  const source = await readFile(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw new WorkspaceConfigError(explainYamlError(error, source), file);
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

/**
 * The credential-store slot this workspace uses.
 *
 * Explicit if the file says so, and otherwise a slug of `name` — which is
 * already required and already committed, so nothing has to be edited for a
 * workspace to stop sharing credentials with its neighbours.
 */
export function namespaceOf(config: Pick<WorkspaceConfig, 'name' | 'secrets'>): Namespace {
  return config.secrets?.namespace ?? namespaceFor(config.name);
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
    throw new WorkspaceConfigError(explainYamlError(error, source), file);
  }
  return validate(interpolate(parsed, env), file);
}

/**
 * The YAML parser's message, plus what it cannot know about a `${…}` reference.
 *
 * `${secret: db_password}` is refused by name when it is quoted. Unquoted — how
 * the example workspace writes `connectionString` — YAML reads the `: ` inside
 * it as a nested mapping and fails first, and the message was "Nested mappings
 * are not allowed in compact mappings", which never mentions a secret. The
 * scenario loader does the same for a `{{…}}` in a flow mapping.
 */
function explainYamlError(error: unknown, source: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = (error as { linePos?: ReadonlyArray<{ line: number }> } | undefined)?.linePos?.[0]
    ?.line;
  const text = line === undefined ? undefined : source.split(/\r?\n/)[line - 1];
  const reference = text?.match(/\$\{[^}\s]*\s[^}]*\}/)?.[0];
  if (!reference) return message;

  const why = /Nested mappings/.test(message)
    ? 'Unquoted, YAML read the `: ` inside it as the start of a nested mapping, so it never reached TupleScope as a reference.'
    : /flow-map|flow-seq/.test(message)
      ? 'Inside `{ … }`, YAML read its `{` as the start of another mapping, so it never reached TupleScope as a reference — quote the whole value.'
      : 'It never reached TupleScope as a reference.';
  return (
    `${message.trimEnd()}\n\n` +
    `Line ${line} holds \`${reference}\`. ${why} ` +
    `A reference takes no spaces: write \`${reference.replace(/\s+/g, '')}\`.`
  );
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

  const panels = doc['panels'];
  if (panels !== undefined) {
    if (!Array.isArray(panels)) return fail('`panels` must be a list');
    for (const [index, entry] of panels.entries()) {
      const panel = entry as Partial<PanelSpec>;
      if (typeof panel?.title !== 'string' || !panel.title) {
        return fail(`panel ${index} has no title`);
      }
      if (panel.unit !== undefined && typeof panel.unit !== 'string') {
        return fail(`panel \`${panel.title}\` has a unit that is not a string`);
      }
      const sources = panel.sources;
      if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) {
        return fail(`panel \`${panel.title}\` needs \`sources\`, a name-to-expression map`);
      }
      const names = Object.entries(sources);
      // A panel with no sources draws an empty box and says nothing about why.
      // Refusing at load beats rendering a frame around nothing.
      if (names.length === 0) return fail(`panel \`${panel.title}\` has no sources`);
      for (const [name, source] of names) {
        if (typeof source !== 'string' || !source) {
          return fail(`panel \`${panel.title}\` source \`${name}\` is not an expression`);
        }
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

  const secrets = doc['secrets'];
  if (secrets !== undefined) {
    if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
      return fail('`secrets` must be a mapping, e.g. `secrets: { namespace: my_project }`');
    }
    const ns = (secrets as Record<string, unknown>)['namespace'];
    if (ns !== undefined && (typeof ns !== 'string' || !NAMESPACE.test(ns))) {
      return fail(
        '`secrets.namespace` must be lower-case letters, digits, underscores and hyphens, ' +
          'starting with a letter or digit',
      );
    }
    for (const key of Object.keys(secrets as object)) {
      if (key !== 'namespace') return fail(`\`secrets.${key}\` is not a setting this understands`);
    }
  }

  const engine = doc['engine'];
  if (engine !== undefined && !ENGINE_NAMES.includes(engine as EngineName)) {
    return fail(
      `\`engine\` must be one of ${ENGINE_NAMES.map((e) => `\`${e}\``).join(', ')}` +
        (typeof engine === 'string' ? `, not \`${engine}\`` : ''),
    );
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

/**
 * Optimal string alignment distance: Levenshtein, plus two adjacent letters
 * swapped counting as one edit.
 *
 * Plain Levenshtein charges a swap twice, and under six letters the threshold
 * above allows one edit — so `nmae` got no "did you mean `name`" at all, and
 * `enigen` (two swaps) none for `engine`; both measured with `tuplescope ls`.
 * A swap is the commonest slip there is, which is why evaluate.ts's `close()`
 * counts it as one too.
 */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

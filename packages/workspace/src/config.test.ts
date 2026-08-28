import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ENGINE_NAMES } from '@statescope/db-postgres';
import { secretsReferencedBy } from './credentials.js';
import {
  findWorkspaceConfig,
  interpolate,
  loadWorkspaceConfig,
  parseWorkspaceConfig,
  WorkspaceConfigError,
} from './config.js';

const VALID = `
name: My API
baseUrl: http://127.0.0.1:8000
database:
  connectionString: postgresql://u:p@127.0.0.1:5432/app
scenariosDir: scenarios
identities:
  - id: alice
    header: { name: authorization, value: "Bearer a" }
ignoreColumns: [updated_at]
baselineWindowMs: 400
`;

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'statescope-ws-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const parse = (source: string, env: Record<string, string | undefined> = {}) =>
  parseWorkspaceConfig(source, join(dir, 'statescope.yaml'), env);

const rejects = (source: string, pattern: RegExp, env: Record<string, string | undefined> = {}) =>
  assert.throws(() => parse(source, env), (error: unknown) => {
    assert.ok(error instanceof WorkspaceConfigError, `expected WorkspaceConfigError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });

// ─── interpolation ────────────────────────────────────────────────────────────

describe('interpolate', () => {
  it('substitutes a set variable', () => {
    assert.equal(interpolate('http://${HOST}:8000', { HOST: 'example.test' }), 'http://example.test:8000');
  });

  it('uses a default when unset, and ignores it when set', () => {
    assert.equal(interpolate('${PORT:-7421}', {}), '7421');
    assert.equal(interpolate('${PORT:-7421}', { PORT: '9000' }), '9000');
    // An empty default is a real value, not a missing one.
    assert.equal(interpolate('${SUFFIX:-}', {}), '');
  });

  it('names the key path when a variable is unset and has no default', () => {
    // The message has to say which setting, or the user greps a YAML file for
    // a variable name that appears three times.
    assert.throws(
      () => interpolate({ database: { connectionString: '${DATABASE_URL}' } }, {}),
      /database\.connectionString.*\$\{DATABASE_URL\}.*not set/s,
    );
  });

  it('escapes a literal with $${', () => {
    assert.equal(interpolate('$${NOT_A_VAR}', {}), '${NOT_A_VAR}');
  });

  it('walks nested objects and arrays', () => {
    const out = interpolate(
      { a: ['${X}', { b: '${Y}' }], c: 1, d: true, e: null },
      { X: '1', Y: '2' },
    );
    assert.deepEqual(out, { a: ['1', { b: '2' }], c: 1, d: true, e: null });
  });

  it('applies after the YAML parse, so a value cannot break the document', () => {
    // A password containing a colon-space would produce invalid YAML if it were
    // substituted into the source text before parsing.
    const config = parse(
      VALID.replace(
        'postgresql://u:p@127.0.0.1:5432/app',
        '${DATABASE_URL}',
      ),
      { DATABASE_URL: 'postgresql://u:pa: ss@h/db' },
    );
    assert.equal(config.database.connectionString, 'postgresql://u:pa: ss@h/db');
  });
});

// ─── validation ───────────────────────────────────────────────────────────────

describe('parseWorkspaceConfig', () => {
  it('reads a valid file and resolves scenariosDir to an absolute path', () => {
    const config = parse(VALID);
    assert.equal(config.name, 'My API');
    assert.equal(config.scenariosDir, join(dir, 'scenarios'));
    assert.equal(config.configDir, dir);
  });

  it('leaves an already-absolute scenariosDir alone', () => {
    const config = parse(VALID.replace('scenariosDir: scenarios', 'scenariosDir: /srv/s'));
    assert.equal(config.scenariosDir, '/srv/s');
  });

  it('suggests the intended key on a typo', () => {
    // Silently ignoring an unknown key means the setting the user thought they
    // applied simply did not happen.
    rejects(VALID.replace('database:', 'databse:'), /unknown key `databse`.*did you mean `database`/);
  });

  it('does not invent a suggestion for something unrelated', () => {
    rejects(`${VALID}\nkubernetesNamespace: prod\n`, /unknown key `kubernetesNamespace`/);
    assert.throws(
      () => parse(`${VALID}\nkubernetesNamespace: prod\n`),
      (e: unknown) => !/did you mean/.test((e as Error).message),
    );
  });

  it('requires the three strings it cannot work without', () => {
    for (const key of ['name', 'baseUrl', 'scenariosDir']) {
      rejects(VALID.replace(new RegExp(`^${key}:.*$`, 'm'), ''), new RegExp(`\`${key}\` is required`));
    }
  });

  it('rejects a baseUrl that is not a URL', () => {
    rejects(VALID.replace('http://127.0.0.1:8000', '127.0.0.1:8000'), /`baseUrl` is not a URL/);
  });

  it('requires database.connectionString', () => {
    rejects(VALID.replace(/database:\n  connectionString:.*/, 'database: {}'), /connectionString` is required/);
  });

  it('rejects duplicate and malformed identities', () => {
    rejects(
      VALID.replace(
        '  - id: alice\n    header: { name: authorization, value: "Bearer a" }',
        '  - id: alice\n    header: { name: authorization, value: "Bearer a" }\n' +
          '  - id: alice\n    header: { name: authorization, value: "Bearer b" }',
      ),
      /two identities share the id `alice`/,
    );
    rejects(
      VALID.replace('header: { name: authorization, value: "Bearer a" }', 'header: {}'),
      /identity `alice` needs header\.name and header\.value/,
    );
  });

  it('rejects a negative baseline window', () => {
    rejects(VALID.replace('baselineWindowMs: 400', 'baselineWindowMs: -1'), /non-negative/);
  });

  it('accepts a named engine and defaults to none', () => {
    assert.equal(parse(VALID).engine, undefined);
    assert.equal(parse(`${VALID}\nengine: snapshot-diff`).engine, 'snapshot-diff');
    assert.equal(parse(`${VALID}\nengine: mvcc-xmin`).engine, 'mvcc-xmin');
  });

  it('accepts every engine the registry offers, without this file listing them', () => {
    // The list comes from the engine registry, so a new engine becomes
    // configurable by being registered. `wal` was rejected here until the day
    // it existed, and became valid without an edit to config.ts.
    for (const name of ENGINE_NAMES) {
      assert.equal(parse(`${VALID}\nengine: ${name}`).engine, name);
    }
    assert.ok(ENGINE_NAMES.length >= 3, `only ${ENGINE_NAMES.length} engines registered`);
  });

  it('rejects an engine nobody implements, and lists the ones that exist', () => {
    // A typo would otherwise fall through to the default and run a different
    // engine than the file asked for, silently.
    rejects(`${VALID}\nengine: mvcc`, /must be one of .*mvcc-xmin.*not `mvcc`/);
  });

  it('leaves a marker for the run to resolve, not the original text', () => {
    // It cannot be resolved here — reading a credential store means talking to
    // another process, and this runs before the config is even validated. What
    // it leaves is a marker rather than `${secret:…}`, because this output is
    // read again and re-reading its own syntax is how the `$${` escape and the
    // environment namespace were both breached.
    const config = parse(VALID.replace('"Bearer a"', '"Bearer ${secret:alice_token}"'));
    const value = config.identities?.[0]?.header?.value ?? '';
    assert.doesNotMatch(value, /\$\{secret:/, 'the re-parseable form must not survive');
    assert.deepEqual(secretsReferencedBy(config), ['alice_token']);
  });

  it('does not resolve a reference the escape was protecting', () => {
    // `$${secret:x}` says "these characters". Emitting them for a later pass to
    // re-read turned that into a credential — verified before this changed.
    // A function replacement, because `String.replace` reads `$$` in a literal
    // replacement as an escape for `$` and would eat the very thing under test.
    const config = parse(VALID.replace('"Bearer a"', () => '"Bearer $${secret:alice_token}"'));
    assert.equal(config.identities?.[0]?.header?.value, 'Bearer ${secret:alice_token}');
    assert.deepEqual(secretsReferencedBy(config), [], 'the escaped text is not a reference');
  });

  it('does not let an environment variable become a secret reference', () => {
    // The namespace crossing the grammar forbids, arriving by the back door:
    // `${VAR}` whose value happens to look like a reference.
    const config = parse(VALID.replace('"Bearer a"', '"Bearer ${SNEAKY}"'), {
      SNEAKY: '${secret:stolen}',
    });
    assert.equal(config.identities?.[0]?.header?.value, 'Bearer ${secret:stolen}');
    assert.deepEqual(secretsReferencedBy(config), [], 'the environment cannot name a secret');
  });

  it('refuses a placeholder it does not recognise, rather than passing it through', () => {
    // The one that mattered: `${secret:x}` matched no pattern here, so it
    // survived as literal text and would have been sent to the API as those
    // characters. Anything `${…}`-shaped is now recognised or refused.
    rejects(VALID.replace('Bearer a', '${SECRET:alice_token}'), /not a secret reference/);
    rejects(VALID.replace('Bearer a', '${not a var}'), /not a reference this understands/);
  });

  it('refuses a default on a secret, because that would be the credential', () => {
    rejects(
      VALID.replace('Bearer a', '${secret:alice_token:-fallback}'),
      /default would be a credential written into/,
    );
  });

  it('still expands an environment variable beside a secret reference', () => {
    const config = parse(
      `${VALID}\nresetUrl: "http://\${HOST:-127.0.0.1}:7421/r?t=\${secret:reset_token}"`,
    );
    assert.match(config.resetUrl ?? '', /^http:\/\/127\.0\.0\.1:7421\/r\?t=/);
    assert.deepEqual(secretsReferencedBy(config), ['reset_token']);
  });

  it('names the file in every error', () => {
    assert.throws(() => parse('name: [unclosed'), new RegExp(dir.replace(/[/\\]/g, '.')));
  });
});

// ─── discovery ────────────────────────────────────────────────────────────────

describe('findWorkspaceConfig', () => {
  it('prefers an explicit path', async () => {
    const path = join(dir, 'explicit.yaml');
    await writeFile(path, VALID, 'utf8');
    assert.equal(await findWorkspaceConfig({ configPath: path }), path);
  });

  it('says so when the explicit path is not there', async () => {
    await assert.rejects(
      findWorkspaceConfig({ configPath: join(dir, 'nope.yaml') }),
      /no such workspace file/,
    );
  });

  it('reads STATESCOPE_CONFIG when no path is given', async () => {
    const path = join(dir, 'from-env.yaml');
    await writeFile(path, VALID, 'utf8');
    assert.equal(await findWorkspaceConfig({ env: { STATESCOPE_CONFIG: path } }), path);
  });

  it('walks up from the working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statescope-walk-'));
    try {
      await writeFile(join(root, 'statescope.yaml'), VALID, 'utf8');
      const deep = join(root, 'a', 'b', 'c');
      await mkdir(deep, { recursive: true });
      assert.equal(await findWorkspaceConfig({ from: deep, env: {} }), join(root, 'statescope.yaml'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops at the repository root rather than escaping into a parent', async () => {
    // A stray statescope.yaml above someone's checkout is a surprising thing to
    // silently pick up.
    const outer = await mkdtemp(join(tmpdir(), 'statescope-outer-'));
    try {
      await writeFile(join(outer, 'statescope.yaml'), VALID, 'utf8');
      const repo = join(outer, 'repo');
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });
      await assert.rejects(
        findWorkspaceConfig({ from: join(repo, 'src'), env: {} }),
        /no statescope\.yaml found/,
      );
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('lists everywhere it looked', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'statescope-empty-'));
    try {
      await mkdir(join(empty, '.git'), { recursive: true });
      await assert.rejects(findWorkspaceConfig({ from: empty, env: {} }), (error: unknown) => {
        assert.match((error as Error).message, new RegExp(empty.replace(/[/\\]/g, '.')));
        assert.match((error as Error).message, /statescope\.example\.yaml/);
        return true;
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('never resolves relative to the installed location of the code', async () => {
    // The runtime used to anchor discovery to `resolve(here, '../../../')`,
    // which under npx resolves into the pnpm store.
    const elsewhere = await mkdtemp(join(tmpdir(), 'statescope-none-'));
    try {
      await mkdir(join(elsewhere, '.git'), { recursive: true });
      await assert.rejects(findWorkspaceConfig({ from: elsewhere, env: {} }), /no statescope\.yaml found/);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('loadWorkspaceConfig', () => {
  it('finds, interpolates and validates in one call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'statescope-load-'));
    try {
      await writeFile(
        join(root, 'statescope.yaml'),
        VALID.replace('http://127.0.0.1:8000', '${API_URL}'),
        'utf8',
      );
      const config = await loadWorkspaceConfig({
        from: root,
        env: { API_URL: 'http://example.test:9000' },
      });
      assert.equal(config.baseUrl, 'http://example.test:9000');
      assert.equal(config.configFile, join(root, 'statescope.yaml'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

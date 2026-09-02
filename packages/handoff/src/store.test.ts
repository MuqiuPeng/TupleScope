/**
 * The file on disk: how it is written, and what a broken one does.
 *
 * The two behaviours worth pinning are opposites. An *absent* file is an empty
 * config, because "nobody has bound anything yet" is the state every machine
 * starts in and the state a refusal should read as. A *malformed* file is an
 * error that propagates, because treating it as empty would discard whatever
 * the user set up and then tell them the alias was never bound.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { OWNER_ONLY_BASIS, OWNER_ONLY_MODE_IS_ENFORCED } from '@tuplescope/core';
import {
  HANDOFF_POLICY_VERSION,
  HandoffConfigError,
  isGranted,
  loadHandoffConfig,
  saveHandoffConfig,
  withGrant,
  withoutBinding,
  withoutGrant,
  type AdminerBinding,
  type HandoffConfigV1,
} from './index.js';

let dir: string;
const path = (): string => join(dir, 'handoff.json');

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tuplescope-handoff-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const binding: AdminerBinding = {
  preset: 'adminer-url',
  origin: 'http://127.0.0.1:8080',
  server: 'postgres:5432',
  username: 'postgres',
  grants: [],
};

describe('reading', () => {
  it('treats an absent file as nothing bound', async () => {
    const config = await loadHandoffConfig(join(dir, 'not-there.json'));
    assert.deepEqual(config, { v: 1, bindings: {} });
  });

  it('refuses a malformed file rather than reading it as empty', async () => {
    // Reading it as empty would discard the user's setup and then tell them the
    // alias was never bound — a message that sends them to fix the wrong thing.
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ not json');
    await assert.rejects(() => loadHandoffConfig(broken), HandoffConfigError);
  });

  it('refuses a file whose binding it does not fully understand', async () => {
    const odd = join(dir, 'odd.json');
    await writeFile(odd, JSON.stringify({ v: 1, bindings: { x: { preset: 'exec-anything' } } }));
    await assert.rejects(() => loadHandoffConfig(odd), /does not know/);
  });
});

describe('writing', () => {
  it('lands at 0600 where that means something, and says so where it does not', async (t) => {
    // Windows has no POSIX permission bits: `chmod` toggles the read-only
    // attribute and a file written this way reports 0666. Asserting 0600 there
    // tests nothing, and deleting the assertion would quietly drop a security
    // property on the platform where it is *not* delivered. The constant names
    // which is which; the README says what stands in its place.
    if (!OWNER_ONLY_MODE_IS_ENFORCED) {
      return t.skip(`mode bits are not enforced here — protection is ${OWNER_ONLY_BASIS}`);
    }
    await saveHandoffConfig({ v: 1, bindings: { adminer: binding } }, path());
    const mode = (await stat(path())).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });

  it('round-trips through the validator, not around it', async () => {
    await saveHandoffConfig({ v: 1, bindings: { adminer: binding } }, path());
    const read = await loadHandoffConfig(path());
    assert.deepEqual(read.bindings['adminer'], binding);
  });

  it('refuses to write a binding the reader would refuse', async () => {
    // The test above only proves a *valid* config survives the trip, which is
    // the easy half. This is the half that matters: the writer accepted
    // anything it was handed, so `handoff enable` on Windows — where an
    // absolute psql path is `C:\\...`, not `/...` — wrote a file that the
    // loader then refused.
    const p = join(dir, 'refused.json');
    await assert.rejects(
      () =>
        saveHandoffConfig(
          {
            v: 1,
            bindings: {
              db: {
                preset: 'psql-service',
                service: 'x',
                executable: 'C:\\Program Files\\psql.exe',
                realpath: 'C:\\Program Files\\psql.exe',
                grants: [],
              },
            },
          } as never,
          p,
        ),
      HandoffConfigError,
    );
    // And it left nothing behind — not the file, not a `.tmp` beside it.
    assert.equal(existsSync(p), false, 'wrote the file anyway');
    assert.equal(
      (await readdir(dir)).some((n) => n.startsWith('refused.json.')),
      false,
      'left a temp file behind',
    );
  });

  it('does not take working bindings down with the bad one', async () => {
    // Why the refusal has to happen at write time rather than being reported at
    // read time: a config is refused as a *file*. One entry the reader cannot
    // parse makes every other binding unreachable, including ones that work —
    // and every CLI route back out (`disable`, `remove`) has to load it first.
    const p = join(dir, 'mixed.json');
    await assert.rejects(
      () =>
        saveHandoffConfig(
          { v: 1, bindings: { adminer: binding, db: { preset: 'nonsense' } } } as never,
          p,
        ),
      HandoffConfigError,
    );
    assert.equal(existsSync(p), false);
  });

  it('leaves no partial file behind', async () => {
    await saveHandoffConfig({ v: 1, bindings: { adminer: binding } }, path());
    const text = await readFile(path(), 'utf8');
    assert.doesNotThrow(() => JSON.parse(text));
    const leftovers = (await readFile(path(), 'utf8')).length;
    assert.ok(leftovers > 0);
  });
});

describe('grants', () => {
  const config: HandoffConfigV1 = { v: 1, bindings: { adminer: binding } };

  it('applies to the workspace it was given for and no other', () => {
    const next = withGrant(config, {
      alias: 'adminer',
      binding,
      workspace: '/home/me/shop',
      now: '2026-01-01T00:00:00.000Z',
    });
    const bound = next.bindings['adminer']!;
    assert.equal(isGranted(bound, '/home/me/shop'), true);
    assert.equal(isGranted(bound, '/home/me/other'), false);
  });

  it('replaces an earlier grant for the same workspace rather than stacking', () => {
    // A grant recorded under an older policy version must not sit beside a
    // current one, or a later narrowing of what counts as granted finds the old
    // row and passes.
    const stale = {
      ...binding,
      grants: [
        {
          workspace: '/home/me/shop',
          approvedAt: 'then',
          approvedBy: 'me',
          policyVersion: HANDOFF_POLICY_VERSION - 1,
        },
      ],
    } as AdminerBinding;
    const next = withGrant(
      { v: 1, bindings: { adminer: stale } },
      { alias: 'adminer', binding: stale, workspace: '/home/me/shop', now: 'now' },
    );
    const grants = next.bindings['adminer']!.grants;
    assert.equal(grants.length, 1);
    assert.equal(grants[0]!.policyVersion, HANDOFF_POLICY_VERSION);
  });

  it('revokes one workspace without touching the others', () => {
    let next = withGrant(config, { alias: 'adminer', binding, workspace: '/a', now: 'n' });
    next = withGrant(next, { alias: 'adminer', binding: next.bindings['adminer']!, workspace: '/b', now: 'n' });
    const revoked = withoutGrant(next, 'adminer', '/a');
    assert.equal(isGranted(revoked.bindings['adminer']!, '/a'), false);
    assert.equal(isGranted(revoked.bindings['adminer']!, '/b'), true);
  });

  it('removes the binding entirely when asked to', () => {
    const gone = withoutBinding(config, 'adminer');
    assert.equal(gone.bindings['adminer'], undefined);
  });
});

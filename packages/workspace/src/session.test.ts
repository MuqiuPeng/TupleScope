/**
 * What a session does when the workspace is not in the state it expects.
 *
 * `status` has always answered an unreachable database with a sentence and a
 * remedy. Every other command answered a missing `scenariosDir` with a raw
 * `ENOENT ... scandir` and a Node stack — on `ls`, which is the second command
 * in the README, on a machine whose only mistake was copying the example config
 * before creating the directory.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadWorkspaceConfig } from './config.js';
import { openWorkspace, WorkspaceError } from './session.js';

const CONFIG = `
name: Fixture
baseUrl: http://127.0.0.1:1
database:
  connectionString: postgresql://u:p@127.0.0.1:1/none
scenariosDir: scenarios
`;

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'statescope-session-'));
  await writeFile(join(root, 'statescope.yaml'), CONFIG, 'utf8');
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Opens against the fixture. Nothing here connects; the DSN points nowhere. */
async function open() {
  return openWorkspace(await loadWorkspaceConfig({ from: root, env: {} }), {
    baselineWindowMs: 0,
    history: false,
  });
}

describe('a scenarios directory that is not there', () => {
  it('reports it with a remedy instead of a scandir stack', async () => {
    const session = await open();
    try {
      await assert.rejects(
        () => session.scenarios(),
        (error: unknown) => {
          assert.ok(error instanceof WorkspaceError, `got ${(error as Error).name}`);
          assert.equal(error.code, 'NO_SCENARIOS_DIR');
          // The two things someone needs in order to act: where it looked, and
          // where the setting that sent it there lives.
          assert.match(error.message, /scenarios/);
          assert.match(error.remedy ?? '', /statescope\.yaml/);
          return true;
        },
      );
    } finally {
      await session.close();
    }
  });

  it('lists nothing — not an error — once the directory exists and is empty', async () => {
    // The distinction the fix must not flatten. An empty workspace is a normal
    // state, and answering it the same way would send someone off to create a
    // directory that is already there.
    await mkdir(join(root, 'scenarios'), { recursive: true });
    const session = await open();
    try {
      assert.deepEqual(await session.scenarios(), []);
    } finally {
      await session.close();
    }
  });
});

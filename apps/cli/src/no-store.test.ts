/**
 * A workspace that refers to a secret, on a machine with no secret store.
 *
 * Linux without a Secret Service, a container, a CI runner. `loadWorkspace`
 * then passes why there is no store down to the resolver, which threw a plain
 * `Error` — so `withWorkspace`, which reports `SecretStoreUnavailable` and
 * `SecretNotConfigured` in one line with exit 4, let it through, and `ls`,
 * `check`, `show` and `run` printed an uncaught exception with a stack trace
 * and exit 2. `status` was fine: it asks the store itself.
 *
 * Driven through the same door `open()` uses, with the store opener that seam
 * exists for, because no macOS machine can be made to lack a keychain.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SecretStoreUnavailable } from '@tuplescope/secrets';
import { loadWorkspace } from '@tuplescope/workspace';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tuplescope-cli-no-store-'));
  await mkdir(join(dir, 'scenarios'));
  await writeFile(
    join(dir, 'tuplescope.yaml'),
    'name: CLI no store test\nbaseUrl: http://127.0.0.1:1\nscenariosDir: scenarios\n' +
      'database:\n  connectionString: postgresql://postgres:${secret:db_password}@127.0.0.1:1/x\n',
  );
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('a secret reference with no secret store', () => {
  it('fails as the error the CLI reports in one line, not as one it prints a stack for', async () => {
    await assert.rejects(
      () =>
        loadWorkspace({
          configPath: join(dir, 'tuplescope.yaml'),
          openStore: async () => ({
            store: undefined,
            reason:
              'there is no D-Bus session bus here, so no keyring can be reached. ' +
              'Use environment variables with `${VAR}`, which is also what a CI runner should use.',
          }),
        }),
      (error: unknown) => {
        // What `withWorkspace` catches and prints as `${error.message}\n`, exit 4.
        assert.ok(error instanceof SecretStoreUnavailable, String(error));
        assert.doesNotMatch(error.message, /\n/);
        assert.match(error.message, /`database\.connectionString` needs the secret `db_password`/);
        assert.match(error.message, /no D-Bus session bus/);
        return true;
      },
    );
  });
});

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { openSecretStore, tryOpenSecretStore } from './detect.js';
import { SecretStoreUnavailable } from './store.js';

describe('choosing a store', () => {
  it('never invents one where the platform has none', async () => {
    await assert.rejects(
      () => openSecretStore({ platform: 'freebsd', namespace: 'demo' }),
      (e: unknown) => {
        assert.ok(e instanceof SecretStoreUnavailable);
        assert.match(e.message, /no credential store for freebsd/);
        assert.match(e.message, /environment variables/);
        return true;
      },
    );
  });

  it('reports why rather than substituting, when asked to try', async () => {
    const result = await tryOpenSecretStore({ platform: 'freebsd', namespace: 'demo' });
    assert.equal(result.store, undefined);
    assert.match((result as { reason: string }).reason, /no credential store for freebsd/);
  });

  it('has no path that writes credentials to a file', () => {
    // The promise, as a test rather than as a comment. A well-meaning fallback
    // added later — a cache, a "development mode", an error handler that saves
    // what it could not store — would keep the syntax and lose the point.
    // `fileURLToPath`, not `.pathname`: on Windows the latter yields
    // `/D:/a/...`, which the filesystem reads as rooted on the current drive
    // and refuses for the colon. Identical on macOS and Linux, which is why
    // it survived — this file has never run anywhere it would fail.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const offences: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      readFileSync(`${dir}${file}`, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Prose about not writing files is not a file write.
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
          if (/writeFile|createWriteStream|appendFile|openSync|\bfs\b/.test(code)) {
            offences.push(`${file}:${i + 1}  ${code}`);
          }
        });
    }
    assert.deepEqual(
      offences,
      [],
      `Something in the secrets package writes to a file. A credential store that falls back ` +
        `to disk keeps the syntax and throws away the only promise it makes.\n${offences.join('\n')}`,
    );
  });
});

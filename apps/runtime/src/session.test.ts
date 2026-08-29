import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// The module reads homedir() at import time, so redirect HOME before loading it.
const fakeHome = mkdtempSync(join(tmpdir(), 'tuplescope-home-'));
const realHome = process.env['HOME'];
process.env['HOME'] = fakeHome;

const { listSessions, removeSession, writeSession } = await import('./session.js');

const base = {
  port: 7420,
  token: 'sekrit',
  url: 'http://127.0.0.1:7420/?token=sekrit',
  workspace: 'Test',
  startedAt: '2026-08-26T00:00:00.000Z',
};

before(() => {});
after(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
});

describe('session file', () => {
  it('records a live instance and reads it back', () => {
    writeSession({ ...base, pid: process.pid });
    const [found] = listSessions();
    assert.equal(found?.url, base.url);
    assert.equal(found?.token, 'sekrit');
  });

  it('is readable only by its owner', () => {
    const path = writeSession({ ...base, pid: process.pid });
    assert.ok(path);
    // The token is in here. 0600, not whatever umask happened to be.
    assert.equal(statSync(path!).mode & 0o777, 0o600);
  });

  it('re-tightens permissions on an existing file', () => {
    // writeFileSync only applies `mode` when it creates the file, so a second
    // start must not inherit looser permissions from the first.
    const path = writeSession({ ...base, pid: process.pid })!;
    chmodSync(path, 0o644);
    writeSession({ ...base, pid: process.pid });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it('drops a stale entry rather than handing out a dead URL', () => {
    writeSession({ ...base, port: 9999, pid: 999_999, url: 'http://dead' });
    const ports = listSessions().map((s) => s.port);
    assert.ok(!ports.includes(9999));
    assert.equal(existsSync(join(fakeHome, '.tuplescope', 'sessions', '9999.json')), false);
  });

  it('drops a corrupt entry too', () => {
    const path = join(fakeHome, '.tuplescope', 'sessions', '9998.json');
    writeFileSync(path, 'not json');
    listSessions();
    assert.equal(existsSync(path), false);
  });

  it('returns newest first', () => {
    writeSession({ ...base, port: 7420, pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z' });
    writeSession({ ...base, port: 7421, pid: process.pid, startedAt: '2026-06-01T00:00:00.000Z' });
    assert.deepEqual(listSessions().map((s) => s.port), [7421, 7420]);
    removeSession(7421);
  });

  it('removes the entry on shutdown', () => {
    writeSession({ ...base, pid: process.pid });
    removeSession(base.port);
    assert.equal(listSessions().some((s) => s.port === base.port), false);
    // Removing twice is not an error; a crashed process never gets here at all.
    removeSession(base.port);
  });

  it('does not leak the token into the filename', () => {
    writeSession({ ...base, pid: process.pid });
    const names = readdirSync(join(fakeHome, '.tuplescope', 'sessions'));
    for (const name of names) assert.doesNotMatch(name, /sekrit/);
    assert.match(readFileSync(join(fakeHome, '.tuplescope', 'sessions', '7420.json'), 'utf8'), /sekrit/);
  });
});

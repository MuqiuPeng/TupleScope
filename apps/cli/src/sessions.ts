/**
 * Where a running instance says who it is.
 *
 * The access token is minted per start and printed once. That is fine while you
 * are watching the terminal and useless afterwards — detach the process, or let
 * a supervisor own it, and the only way back in is a restart. So each instance
 * also drops a small session file, and `statescope url` reads it.
 *
 * Jupyter solved this the same way, for the same reason.
 *
 * On permissions: the token is already sitting in plaintext in whatever log the
 * supervisor captured, usually world-readable. A 0600 file under the user's own
 * home is strictly better hygiene, not a new exposure. It still means a process
 * running as this user can read it — see the note in `security.ts` about what
 * the token can and cannot defend against.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.statescope', 'sessions');

export interface Session {
  pid: number;
  port: number;
  token: string;
  url: string;
  workspace: string;
  startedAt: string;
}

function fileFor(port: number): string {
  return join(DIR, `${port}.json`);
}

/** Records this instance. Best effort: a read-only home must not stop the server. */
export function writeSession(session: Session): string | undefined {
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const path = fileFor(session.port);
    writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync only applies mode when creating, so an existing file from a
    // previous start keeps its old permissions unless we set them again.
    chmodSync(path, 0o600);
    return path;
  } catch {
    return undefined;
  }
}

export function removeSession(port: number): void {
  try {
    rmSync(fileFor(port), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/** True if a process with this pid exists. Signal 0 checks without delivering. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Every instance that still looks live, newest first.
 *
 * A crash leaves the file behind, so a stale entry is deleted rather than
 * reported — handing someone a dead URL is worse than saying nothing.
 */
export function listSessions(): Session[] {
  let names: string[];
  try {
    names = readdirSync(DIR).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }

  const live: Session[] = [];
  for (const name of names) {
    const path = join(DIR, name);
    try {
      const session = JSON.parse(readFileSync(path, 'utf8')) as Session;
      if (alive(session.pid)) live.push(session);
      else rmSync(path, { force: true });
    } catch {
      rmSync(path, { force: true });
    }
  }
  return live.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Where `--junit <path>` is going to write, checked before it matters.
 *
 * Measured: `tuplescope report run.json --junit /nonexistent-dir/out.xml`
 * answered with a Node stack trace and exit 2 — "a step could not be executed"
 * — from a command that executes no steps. Under `run` the same path is worse:
 * the whole suite runs against the database first, and the report the exit
 * code refers to is then never written.
 *
 * One sentence, naming the path and the reason, for both. `run` asks it before
 * sending a request; a write that still fails afterwards says the same thing.
 */

import { accessSync, constants, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function cannotWrite(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const reason =
    code === 'ENOENT'
      ? `the directory ${dirname(resolve(path))} does not exist`
      : code === 'ENOTDIR'
        ? 'part of that path is a file, not a directory'
        : code === 'EISDIR'
          ? 'that is a directory'
          : code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
            ? 'permission denied'
            : error instanceof Error
              ? error.message
              : String(error);
  return `Cannot write the JUnit report to ${path}: ${reason}.`;
}

/** Why `path` cannot be written, or undefined when it can. `-` is stdout. */
export function junitTargetProblem(path: string): string | undefined {
  if (path === '-') return undefined;
  const target = resolve(path);
  try {
    const existing = statSync(target, { throwIfNoEntry: false });
    if (existing?.isDirectory()) return cannotWrite(path, { code: 'EISDIR' });
    if (existing) {
      accessSync(target, constants.W_OK);
      return undefined;
    }
    const dir = statSync(dirname(target));
    if (!dir.isDirectory()) return cannotWrite(path, { code: 'ENOTDIR' });
    accessSync(dirname(target), constants.W_OK);
    return undefined;
  } catch (error) {
    return cannotWrite(path, error);
  }
}

/**
 * Written synchronously: a report the exit code refers to must exist before
 * the process leaves, even on a signal. Returns the sentence when it could not.
 */
export function writeJUnitFile(path: string, xml: string): string | undefined {
  try {
    writeFileSync(path, xml, 'utf8');
    return undefined;
  } catch (error) {
    return cannotWrite(path, error);
  }
}

#!/usr/bin/env node
/**
 * The `bin` entry, and deliberately not `dist/server.js`.
 *
 * A package manager links a bin when it *installs*, and silently skips one
 * whose target file is not there — pnpm 9.15.2 does not even warn. `dist/` is
 * built, not committed, so a bin pointing straight at it is skipped by the
 * first `pnpm install` and the command never appears; the build that would
 * have created it runs too late, and a later build does not re-link. That is
 * why `statescope-mcp` did not exist after the documented two-command install.
 *
 * This file is committed, so the link always happens. The one thing it does
 * before handing over is say plainly when the build has not run yet.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const main = new URL('../dist/server.js', import.meta.url);

if (existsSync(fileURLToPath(main))) {
  await import(main.href);
} else {
  // 4 is this CLI's "bad invocation, or a workspace that will not load".
  // `exitCode` rather than `exit()`, for the reason main.js gives: a piped
  // write is async, and exiting truncates it.
  process.exitCode = 4;
  process.stderr.write(
    'statescope-mcp is not built yet.\nRun `pnpm build` at the repository root, then try again.\n',
  );
}

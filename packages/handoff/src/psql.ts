/**
 * The `psql-service` target: a program of the user's, run with their
 * credentials, told nothing it did not already know.
 *
 * Not an interactive session. StateScope spawns, writes SQL on stdin, and
 * renders the captured stdout. Three rules make that safe, and each closes a
 * specific hole:
 *
 *   argv   nothing interpolated, ever. A `.exe` that is really a shim
 *          (Chocolatey, scoop, App Execution Aliases) re-derives its own
 *          command line internally and is undetectable from here; the only
 *          defence is that there is nothing variable for it to re-derive.
 *   env    the service name and an allow-list. `PSQLRC`, `PAGER`, `PGOPTIONS`
 *          and `LD_PRELOAD` each turn a child into an interpreter or a liar.
 *   stdin  identifiers and literals through the shared renderer. Correct
 *          escaping is what stops a captured key value from reaching
 *          backslash-meta-command position — `-X` disables `psqlrc`, it does
 *          **not** disable `\!` read from stdin.
 *
 * The connection is the user's: `PGSERVICE` names an entry in their own
 * `pg_service.conf`, and their own `~/.pgpass` supplies the password. StateScope
 * never reads either file and never sees a credential.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import type { KnownLocation, Value } from '@statescope/core';
import { renderGuard, renderSelect } from '@statescope/core';
import type { PsqlServiceBinding } from './config.js';

/** Fixed literals. Not a template, not a config key, not concatenated. */
const ARGS = [
  '--no-psqlrc',
  '--no-password',
  '--set=ON_ERROR_STOP=1',
  '--pset=pager=off',
  '--quiet',
  '--file=-',
] as const;

export const DEFAULT_TIMEOUT_MS = 15_000;
/** Beyond this the output is not being read, it is being scrolled past. */
export const MAX_OUTPUT_BYTES = 256 * 1024;

export interface PsqlResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the child was killed rather than finishing. */
  readonly killed?: 'timeout' | 'output-cap';
  readonly exitCode: number | null;
}

export interface PsqlOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** For tests. Production always resolves against the recorded realpath. */
  skipRealpathCheck?: boolean;
}

/**
 * The exact bytes written to stdin.
 *
 * Exported so a confirmation can show the user precisely what will run. A
 * dialog that paraphrases is a dialog nobody can check.
 */
export function psqlScript(location: KnownLocation, table: string, key: ReadonlyArray<{ name: string; value: Value }>): string {
  return `${renderGuard(location.database, location.schema, table)}\n${renderSelect(
    location.schema,
    table,
    key,
  )}\n`;
}

export class PsqlRefused extends Error {
  override readonly name = 'PsqlRefused';
}

export async function runPsql(
  binding: PsqlServiceBinding,
  script: string,
  options: PsqlOptions = {},
): Promise<PsqlResult> {
  if (process.platform === 'win32' && !binding.executable.toLowerCase().endsWith('.exe')) {
    throw new PsqlRefused(
      `\`${binding.executable}\` does not end in .exe. On Windows a path that is not an executable ` +
        'image can be a shim that rewrites its own command line.',
    );
  }
  if (!options.skipRealpathCheck) {
    // Re-checked at spawn against what was recorded at enable time. This does
    // not close the TOCTOU window — nothing portable does — but it converts a
    // substitution from silent into a refusal the user has to look at.
    let now: string;
    try {
      now = await realpath(binding.executable);
    } catch {
      throw new PsqlRefused(`\`${binding.executable}\` is no longer there. Re-run \`statescope handoff enable\`.`);
    }
    if (now !== binding.realpath) {
      throw new PsqlRefused(
        `\`${binding.executable}\` now resolves to \`${now}\`, not the \`${binding.realpath}\` that was approved. ` +
          'Re-run `statescope handoff enable` if that change was yours.',
      );
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  return await new Promise<PsqlResult>((resolve) => {
    const child = spawn(binding.executable, [...ARGS], {
      shell: false,
      windowsVerbatimArguments: false,
      windowsHide: true,
      // No controlling tty, so libpq cannot fall back to prompting for a
      // password on a terminal the user is not looking at.
      detached: process.platform !== 'win32',
      // Never the workspace: a `.psqlrc` or a relative include sitting in a
      // checked-out repository is repo-supplied input to a program running as
      // the user.
      cwd: homedir(),
      env: {
        PGSERVICE: binding.service,
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? homedir(),
        LC_ALL: 'C',
        PGCONNECT_TIMEOUT: '10',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed: PsqlResult['killed'];
    let settled = false;

    const stop = (why: PsqlResult['killed']): void => {
      killed = why;
      kill(child, 'SIGTERM');
      setTimeout(() => kill(child, 'SIGKILL'), 500).unref();
    };

    // Attached before the first stdin byte. A child that writes an error
    // immediately and exits can otherwise fill and close its pipe before
    // anything is listening, and the message is simply gone.
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > cap) {
        stdout = `${stdout.slice(0, cap)}\n… output capped at ${cap} bytes`;
        stop('output-cap');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // EPIPE here is information, not a crash: it means the child went away
    // before reading the script, which the exit handler is about to report
    // properly.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, stdout, stderr: `${stderr}${error.message}`, exitCode: null });
    });

    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    timer.unref();

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        ok: code === 0 && killed === undefined,
        stdout,
        stderr,
        exitCode: code,
        ...(killed ? { killed } : {}),
      });
    });

    child.stdin.end(script);
  });
}

/**
 * To the process **group**, not the process.
 *
 * psql spawns nothing of its own today, but a signal delivered only to the
 * leader leaves anything it did spawn holding the pipes open, and the promise
 * above never settles.
 */
function kill(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone. Nothing to salvage and nothing to report.
  }
}

/** The standing line, and the one-time refusal. Both live here, for one voice. */
export function psqlDisclosure(binding: PsqlServiceBinding): {
  standing: string;
  firstUse: (script: string, alias: string, maskedColumns: ReadonlyArray<string>) => string;
} {
  return {
    standing: `Inspect → psql, service ${binding.service} · SQL on stdin, not in ps`,
    firstUse: (script, alias, maskedColumns) =>
      [
        `Open in psql  ·  not enabled on this machine`,
        ``,
        `  This would run, as you, with your credentials:`,
        ``,
        `    ${binding.executable} ${ARGS.join(' ')}`,
        ``,
        `  connecting through service \`${binding.service}\` from your own pg_service.conf,`,
        `  with your own ~/.pgpass. StateScope never reads either file.`,
        ``,
        `  The SQL goes on stdin, so the key never appears in \`ps\`:`,
        ``,
        script
          .trimEnd()
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
        ``,
        maskedColumns.length > 0
          ? `  psql is not bound by maskColumns — it will show ${maskedColumns.join(', ')} in full.`
          : `  psql is not bound by maskColumns.`,
        ``,
        `  \`${alias}\` is a name this repository chose. Bind it yourself, once:`,
        ``,
        `    statescope handoff enable psql-service --as ${alias} --service ${binding.service}`,
        ``,
        `  Written to ~/.statescope/handoff.json, which this repository cannot write.`,
        `  statescope handoff list · statescope handoff disable`,
      ].join('\n'),
  };
}

/**
 * Handing a URL to the platform's own opener.
 *
 * `execFile`, never a shell, and the URL as a single argv element — the same
 * rule as every other spawn here. A URL carries `&`, `?` and `;`, all of which
 * mean something to a shell and nothing to `open(1)`, and the values in this
 * one came out of a database.
 */

import { execFile } from 'node:child_process';

const OPENER: Readonly<Record<string, { command: string; args: string[] }>> = {
  darwin: { command: '/usr/bin/open', args: [] },
  linux: { command: 'xdg-open', args: [] },
  // `start` is a cmd builtin, and its first quoted argument is the *window
  // title*. The empty string is that title; without it a quoted URL is
  // swallowed and nothing opens.
  win32: { command: 'cmd', args: ['/c', 'start', ''] },
};

export async function openUrl(url: string): Promise<void> {
  const opener = OPENER[process.platform];
  if (!opener) throw new Error(`No known way to open a URL on ${process.platform}.`);
  await new Promise<void>((resolve, reject) => {
    execFile(opener.command, [...opener.args, url], { shell: false }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

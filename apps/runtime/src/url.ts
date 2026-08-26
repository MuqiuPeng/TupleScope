/**
 * `statescope url` — hand back the URL of a running instance, token and all.
 *
 * Exists because "the runtime printed it once, an hour ago, in a terminal you
 * have since closed" is not a way to find a credential.
 *
 *   pnpm url            the newest live instance
 *   pnpm url --all      every one
 *   open "$(pnpm -s url)"
 */
import { listSessions } from './session.js';

const sessions = listSessions();

if (sessions.length === 0) {
  console.error(
    'No StateScope instance is running.\n' +
      'Start one with `pnpm start`; it will print its URL and record it for next time.',
  );
  process.exit(1);
}

if (process.argv.includes('--all')) {
  for (const s of sessions) {
    console.log(`${s.url}    ${s.workspace} (pid ${s.pid}, since ${s.startedAt})`);
  }
} else {
  // Bare URL on stdout so it composes: open "$(pnpm -s url)".
  console.log(sessions[0]!.url);
  if (sessions.length > 1) {
    console.error(`(${sessions.length - 1} other instance(s) running — pnpm url --all)`);
  }
}

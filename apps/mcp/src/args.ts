/**
 * What `tuplescope-mcp` accepts on its command line: `--config <path>`.
 *
 * It accepted nothing and ignored whatever it was given, while the error it
 * returns for a missing workspace told the agent to "pass --config". Measured: a
 * client configured with `args: ["--config", <a valid path>]` got "no
 * tuplescope.yaml found" from every tool. The flag means what the CLI's does,
 * with the precedence the README states — the flag, then `TUPLESCOPE_CONFIG`,
 * then the walk up from the working directory.
 *
 * Anything else is refused at startup rather than ignored, for the same
 * reason: an option that silently does nothing is how this was found.
 *
 * `--version` is accepted because refusing it broke something that had only
 * ever worked by accident. CI's Windows leg checks the linked shim with
 * `tuplescope-mcp.cmd --version`; before this parser existed the flag was
 * ignored, the server started, found stdin closed and exited 0, and the step
 * passed. Once unknown options were refused it exited 4. A bin that answers
 * `--version` is what that step, and anyone checking an install, expects.
 */

import { parseArgs } from 'node:util';

export const USAGE = `Usage: tuplescope-mcp [--config <path>]

  --config <path>   the workspace file to serve. Without it: TUPLESCOPE_CONFIG,
                    then the nearest tuplescope.yaml above the working directory.
  --version         print the version and the run-report schema, then exit.

Speaks MCP over stdin and stdout; an MCP client starts it.
`;

export type ServerArgs =
  | { readonly kind: 'serve'; readonly configPath?: string }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'refused'; readonly message: string };

export function parseServerArgs(argv: ReadonlyArray<string>): ServerArgs {
  const refuse = (why: string): ServerArgs => ({ kind: 'refused', message: `tuplescope-mcp: ${why}\n\n${USAGE}` });
  let values: { config?: string | undefined; help?: boolean | undefined; version?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  // Before help, as the CLI orders them: `--version --help` answers the version.
  if (values.version) return { kind: 'version' };
  if (values.help) return { kind: 'help' };
  // An empty path would fall through discovery to the walk up — the flag
  // given, and silently not used.
  if (values.config === '') return refuse('--config needs a path.');
  return values.config === undefined ? { kind: 'serve' } : { kind: 'serve', configPath: values.config };
}

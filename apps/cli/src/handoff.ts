/**
 * `tuplescope handoff …` — binding a name the repository chose to a program
 * on this machine.
 *
 * The command exists because the binding cannot be made any other way. A
 * project's `tuplescope.yaml` contributes one alias and nothing else; until
 * someone types this, that alias resolves to nothing and every attempt to use
 * it is a refusal. There is deliberately no flag, no environment variable and
 * no config key that skips it — a confirmation the mouse can complete, or that
 * a file can pre-answer, is not a decision anybody made.
 *
 * `enable` is scoped to one workspace at a time. A machine-wide grant is the
 * thing a "remember this" checkbox reaches within four clicks, chosen
 * mid-debugging, and it is not offered here at all.
 */

import { realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { findWorkspaceConfig, loadWorkspaceConfig } from '@tuplescope/workspace';
import {
  assertOrigin,
  HandoffConfigError,
  isGranted,
  isLoopback,
  loadHandoffConfig,
  saveHandoffConfig,
  SERVER,
  SERVICE,
  USERNAME,
  withGrant,
  withoutBinding,
  withoutGrant,
  workspaceKey,
  type Binding,
} from '@tuplescope/handoff';

const EXIT_USAGE = 4;
const EXIT_ERROR = 2;

const USAGE = `tuplescope handoff — open an observed row in a database tool of yours

  tuplescope handoff list                     what is bound on this machine
  tuplescope handoff enable <preset> --as <alias> [options]
  tuplescope handoff disable <alias>          revoke it for this workspace
  tuplescope handoff disable <alias> --everywhere

Presets

  adminer-url    open a URL in your browser. Adminer connects with its own
                 credentials, as you, and is not bound by maskColumns.
      --origin <url>       where the browser goes      (loopback unless flagged)
      --server <host:port> PostgreSQL *as Adminer reaches it*
      --username <role>    the role Adminer is logged in as

  psql-service   run your psql, with your credentials, SQL on stdin
      --service <name>     an entry in your own pg_service.conf

A repository can name an alias. It cannot create one, point one somewhere, or
approve one — that is what this file is for. Written to ~/.tuplescope/handoff.json,
mode 0600, which no project can write.
`;

export interface HandoffValues {
  config?: string;
  as?: string;
  origin?: string;
  server?: string;
  username?: string;
  service?: string;
  everywhere?: boolean;
  'i-know-this-is-not-local'?: boolean;
  json?: boolean;
}

export async function commandHandoff(args: string[], values: HandoffValues): Promise<number> {
  const action = args[0];
  try {
    switch (action) {
      case 'list':
        return await list(values);
      case 'enable':
        return await enable(args[1], values);
      case 'disable':
        return await disable(args[1], values);
      default:
        process.stdout.write(USAGE);
        return action === undefined ? 0 : EXIT_USAGE;
    }
  } catch (error) {
    if (error instanceof HandoffConfigError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }
}

async function list(values: HandoffValues): Promise<number> {
  const config = await loadHandoffConfig(undefined, { allowRemote: true });
  const here = await hereFor(values);
  const entries = Object.entries(config.bindings);

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ workspace: here, ...config }, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(
      'Nothing is bound on this machine.\n\n' +
        'A scenario that names a handoff target will refuse and print the command to bind it.\n',
    );
    return 0;
  }

  for (const [alias, binding] of entries) {
    const granted = isGranted(binding, here);
    process.stdout.write(`${alias}  ${binding.preset}\n`);
    if (binding.preset === 'adminer-url') {
      process.stdout.write(`  browser  ${binding.origin}\n`);
      process.stdout.write(`  database ${binding.server} as ${binding.username}\n`);
      if (!isLoopback(binding.origin)) {
        process.stdout.write(`  ⚠ not loopback — an approved host can serve anything later\n`);
      }
    } else {
      process.stdout.write(`  service  ${binding.service}\n`);
      process.stdout.write(`  psql     ${binding.executable}\n`);
      if (binding.executable !== binding.realpath) {
        process.stdout.write(`           → ${binding.realpath}\n`);
      }
    }
    // The grants are the part worth reading: a binding that exists is not a
    // binding that applies here.
    process.stdout.write(
      `  here     ${granted ? 'enabled' : 'not enabled for this workspace'}  (${here})\n`,
    );
    for (const grant of binding.grants) {
      if (grant.workspace === here) continue;
      process.stdout.write(`  also     ${grant.workspace}\n`);
    }
    process.stdout.write('\n');
  }
  return 0;
}

async function enable(preset: string | undefined, values: HandoffValues): Promise<number> {
  const alias = values.as;
  if (!alias) {
    process.stderr.write('`--as <alias>` is required: it is the name the project refers to.\n');
    return EXIT_USAGE;
  }

  let binding: Binding;
  switch (preset) {
    case 'adminer-url': {
      const origin = values.origin;
      const server = values.server;
      const username = values.username;
      if (!origin || !server || !username) {
        const own = await ownDatabaseAddress(values);
        process.stderr.write(
          'adminer-url needs --origin, --server and --username.\n\n' +
            'They are three different addresses and none is derivable from the others:\n' +
            '  --origin    where your browser goes\n' +
            '  --server    PostgreSQL as *Adminer* reaches it\n' +
            '  --username  the role Adminer logs in as\n\n' +
            (own
              ? `This workspace reaches PostgreSQL at \`${own.hostPort}\`.\n` +
                (own.fromContainer === own.hostPort
                  ? // A real hostname resolves the same from inside a container as
                    // outside it, so there is only one candidate and saying
                    // otherwise would invent a second.
                    '  --server    that address, unless Adminer resolves the name differently\n'
                  : // A loopback address means *this* machine, and inside a
                    // container that is the container. Docker publishes the host
                    // under a different name.
                    `  --server    \`${own.hostPort}\` if Adminer runs on this machine\n` +
                    `              \`${own.fromContainer}\` if it runs in a container — loopback\n` +
                    '              inside one means the container, not this host\n') +
                (own.username ? `  --username  probably \`${own.username}\`, the role this workspace connects as\n` : '') +
                '\nTupleScope will not choose for you: only you know where Adminer runs.\n'
              : 'If Adminer runs in a container, --server is its view of the database, not yours.\n'),
        );
        return EXIT_USAGE;
      }
      assertOrigin(origin, values['i-know-this-is-not-local'] ?? false);
      if (!SERVER.test(server)) {
        process.stderr.write(`\`${server}\` is not a host[:port].\n`);
        return EXIT_USAGE;
      }
      if (!USERNAME.test(username)) {
        process.stderr.write(`\`${username}\` is not usable as a role name here.\n`);
        return EXIT_USAGE;
      }
      binding = { preset: 'adminer-url', origin, server, username, grants: [] };
      break;
    }
    case 'psql-service': {
      const service = values.service;
      if (!service) {
        process.stderr.write('psql-service needs --service <name>, an entry in your pg_service.conf.\n');
        return EXIT_USAGE;
      }
      if (!SERVICE.test(service)) {
        process.stderr.write(`\`${service}\` is not a service name.\n`);
        return EXIT_USAGE;
      }
      const found = await findPsql();
      if (!found) {
        process.stderr.write(
          'No `psql` found on PATH.\n\n' +
            'TupleScope resolves it once, here, and stores the absolute path and its realpath — ' +
            'so that what runs later is what you approved now, and a substitution becomes a refusal ' +
            'rather than a surprise.\n',
        );
        return EXIT_USAGE;
      }
      binding = {
        preset: 'psql-service',
        service,
        executable: found.executable,
        realpath: found.realpath,
        grants: [],
      };
      break;
    }
    default:
      process.stderr.write(
        `Unknown preset ${JSON.stringify(preset ?? '')}. Known: adminer-url, psql-service.\n`,
      );
      return EXIT_USAGE;
  }

  const config = await loadHandoffConfig(undefined, { allowRemote: true });
  const here = await hereFor(values);
  // Carried over, so re-running `enable` from a second workspace adds a grant
  // rather than silently revoking the first.
  const existing = config.bindings[alias];
  const withGrants: Binding =
    existing && existing.preset === binding.preset
      ? ({ ...binding, grants: existing.grants } as Binding)
      : binding;

  const next = withGrant(config, {
    alias,
    binding: withGrants,
    workspace: here,
    now: new Date().toISOString(),
  });
  await saveHandoffConfig(next);

  process.stdout.write(`\`${alias}\` is now enabled for ${here}.\n\n`);
  if (binding.preset === 'adminer-url') {
    process.stdout.write(
      `Opening a row sends its key to ${binding.origin} in the URL, and the browser keeps it: ` +
        'history, address-bar autocomplete, and whatever this profile syncs.\n' +
        'Adminer connects as ' +
        binding.username +
        ' with its own credentials and is not bound by maskColumns.\n',
    );
    if (!isLoopback(binding.origin)) {
      process.stdout.write(
        '\n⚠ This origin is not loopback. An approved host can serve anything later, and DNS ' +
          'moves under a stable name. This will be reprinted every time it is used.\n',
      );
    }
  } else {
    process.stdout.write(
      `Opening a row runs ${binding.executable} as you, through service \`${binding.service}\`, ` +
        'with your own credentials. The SQL goes on stdin, so the key never appears in `ps`.\n' +
        'psql is not bound by maskColumns.\n',
    );
  }
  process.stdout.write('\ntuplescope handoff list · tuplescope handoff disable\n');
  return 0;
}

async function disable(alias: string | undefined, values: HandoffValues): Promise<number> {
  if (!alias) {
    process.stderr.write('Which alias? `tuplescope handoff disable <alias>`\n');
    return EXIT_USAGE;
  }
  const config = await loadHandoffConfig(undefined, { allowRemote: true });
  if (!config.bindings[alias]) {
    process.stdout.write(`\`${alias}\` is not bound on this machine. Nothing to do.\n`);
    return 0;
  }
  const here = await hereFor(values);
  const next = values.everywhere
    ? withoutBinding(config, alias)
    : withoutGrant(config, alias, here);
  await saveHandoffConfig(next);
  process.stdout.write(
    values.everywhere
      ? `\`${alias}\` removed. It is bound nowhere now.\n`
      : `\`${alias}\` is no longer enabled for ${here}. Other workspaces keep it.\n`,
  );
  return 0;
}

/**
 * Resolves `psql` once, against a PATH this builds rather than inherits.
 *
 * Never `node_modules/.bin` and never the workspace: a `psql` sitting in a
 * checked-out repository is repo-supplied, and the whole point of this file is
 * that the repository does not choose the program.
 */
async function findPsql(): Promise<{ executable: string; realpath: string } | undefined> {
  const inherited = (process.env['PATH'] ?? '').split(delimiter).filter((entry) => {
    if (!entry || !isAbsolute(entry)) return false;
    return !entry.includes('node_modules') && !entry.startsWith(process.cwd());
  });
  const candidates = [
    ...inherited,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/usr/pgsql-16/bin',
  ];
  const name = process.platform === 'win32' ? 'psql.exe' : 'psql';
  for (const dir of candidates) {
    const executable = join(dir, name);
    try {
      await access(executable, constants.X_OK);
      return { executable, realpath: await realpath(executable) };
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/**
 * The workspace a grant is for: the one the config names, not the shell's cwd.
 *
 * These were the same thing right up until someone ran `tuplescope handoff
 * enable --config path/to/tuplescope.yaml` for the workspace it is for,
 * and the grant landed on the repository root while the runtime — which
 * resolves it from `configDir` — went on refusing. A grant that names a
 * different directory from the one that checks it is a grant that silently
 * does nothing.
 *
 * Falls back to the cwd when there is no workspace to find, which is the case
 * for `handoff list` run from anywhere.
 */
async function hereFor(values: HandoffValues): Promise<string> {
  try {
    const file = await findWorkspaceConfig(
      values.config !== undefined ? { configPath: values.config } : {},
    );
    return await workspaceKey(dirname(file));
  } catch {
    return await workspaceKey(process.cwd());
  }
}

/**
 * Where this workspace reaches PostgreSQL, as two candidates rather than a guess.
 *
 * The `--server` flag is the one address TupleScope genuinely cannot derive —
 * it is the database *as Adminer sees it*, and Adminer may be in a container
 * whose view differs. But "go and find out" is a poor answer when the workspace
 * config already names the host and port, and when the container case has one
 * overwhelmingly common answer. Offering both and refusing to choose is the
 * honest middle.
 *
 * Host and port only. The connection string may carry a password, and a
 * usage message is exactly the kind of place one gets pasted from.
 */
async function ownDatabaseAddress(
  values: HandoffValues,
): Promise<{ hostPort: string; fromContainer: string; username?: string } | undefined> {
  try {
    const file = await findWorkspaceConfig(
      values.config !== undefined ? { configPath: values.config } : {},
    );
    const config = await loadWorkspaceConfig({ configPath: file });
    const url = new URL(config.database.connectionString);
    const host = url.hostname;
    const port = url.port || '5432';
    if (!host) return undefined;
    const user = decodeURIComponent(url.username);
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return {
      hostPort: `${host}:${port}`,
      // Only meaningful for a loopback address: a hostname that already resolves
      // somewhere is as likely to resolve there from inside a container too.
      fromContainer: loopback ? `host.docker.internal:${port}` : `${host}:${port}`,
      ...(user ? { username: user } : {}),
    };
  } catch {
    // No workspace, an unresolved `${secret:…}` in the DSN, or a string that is
    // not a URL. The generic message is still correct; a wrong hint would not be.
    return undefined;
  }
}

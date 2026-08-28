/**
 * `statescope secret …` — the four things a person needs to do with a
 * credential this tool will later read.
 *
 * Two decisions in here are about what the commands deliberately do *not* do.
 *
 * `get` prints whether a secret is configured, not what it is. The reason a
 * credential is in a keychain instead of a file is that it should not be casual
 * to display, and a command whose everyday use puts a bearer token in terminal
 * scrollback and shell history is not that. `--show` exists for the times it is
 * genuinely needed, and says so.
 *
 * `set` never takes the value as an argument. A `--value` flag would put the
 * credential in the shell's history file and in `ps` — the two places it is
 * hardest to get back out of. It is read from the terminal with the echo off,
 * or from a pipe when there is no terminal.
 */

import { openSecretStore, SecretStoreUnavailable, type SecretStore } from '@statescope/secrets';
import { loadWorkspaceConfig, namespaceOf } from '@statescope/workspace';

const EXIT_USAGE = 4;
const EXIT_ERROR = 2;

const USAGE = `statescope secret — credentials a workspace refers to but does not contain

  statescope secret set <name>      store a value, read from the terminal or a pipe
  statescope secret get <name>      whether it is configured; --show to print it
  statescope secret list            every secret this tool stored on this machine
  statescope secret delete <name>   remove one

A workspace refers to these by name, and never contains the value:

  identities:
    - id: alice
      header: { name: authorization, value: "Bearer \${secret:alice_token}" }

\`\${secret:name}\` reads only this store. \`\${VAR}\` reads only the environment.
Neither ever falls back to the other, so a credential's origin is always the
one the file names.
`;

export async function commandSecret(
  args: string[],
  values: { show?: boolean; config?: string },
): Promise<number> {
  const [action, name] = args;
  if (!action || action === 'help') {
    process.stdout.write(USAGE);
    return action ? 0 : EXIT_USAGE;
  }

  // Secrets belong to a workspace, so these commands need one. Falling back to
  // a shared slot would put two projects' `api_token` in one place, and the
  // collision looks exactly like a correct setup.
  let namespace: string;
  let workspace: string;
  try {
    const config = await loadWorkspaceConfig({
      ...(values.config !== undefined ? { configPath: values.config } : {}),
    });
    namespace = namespaceOf(config);
    workspace = config.name;
  } catch (error) {
    process.stderr.write(
      `${(error as Error).message}\n\n` +
        `Secrets belong to a workspace: the name a reference uses is stored under that ` +
        `workspace's own slot, so two projects that both want \`api_token\` do not collide. ` +
        `Run this from a directory with a statescope.yaml, or pass --config.\n`,
    );
    return EXIT_USAGE;
  }

  let store: SecretStore;
  try {
    store = await openSecretStore({ namespace });
  } catch (error) {
    if (error instanceof SecretStoreUnavailable) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }

  switch (action) {
    case 'set':
      return commandSet(store, name);
    case 'get':
      return commandGet(store, name, values.show === true);
    case 'list':
      return commandListSecrets(store, workspace);
    case 'delete':
    case 'rm':
      return commandDelete(store, name);
    default:
      process.stderr.write(`Unknown secret command \`${action}\`.\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}

async function commandSet(store: SecretStore, name: string | undefined): Promise<number> {
  if (!name) {
    process.stderr.write('Which secret? `statescope secret set <name>`\n');
    return EXIT_USAGE;
  }
  const value = await readValue(name);
  if (value === undefined) return EXIT_USAGE;
  if (value === '') {
    process.stderr.write('Nothing was entered, so nothing was stored.\n');
    return EXIT_USAGE;
  }
  try {
    await store.set(name, value);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return EXIT_ERROR;
  }
  process.stdout.write(`${name}  stored in the ${store.description}\n`);
  return 0;
}

async function commandGet(
  store: SecretStore,
  name: string | undefined,
  show: boolean,
): Promise<number> {
  if (!name) {
    process.stderr.write('Which secret? `statescope secret get <name>`\n');
    return EXIT_USAGE;
  }
  const found = await store.get(name);
  if (!found) {
    process.stdout.write(`${name}  not configured\n`);
    return 1;
  }
  if (show) {
    // The value alone on stdout, so it can be piped without also piping a
    // label. Everything else this command prints goes to stderr for that
    // reason.
    process.stderr.write(`${name}  showing the value; it will be in your shell history\n`);
    process.stdout.write(`${found.reveal()}\n`);
    return 0;
  }
  process.stdout.write(`${name}  configured\n`);
  return 0;
}

async function commandListSecrets(store: SecretStore, workspace: string): Promise<number> {
  const stored = await store.list();
  if (stored.length === 0) {
    process.stdout.write(
      `No secrets stored for \`${workspace}\`. Add one with \`statescope secret set <name>\`, ` +
        `and refer to it from the workspace as \`\${secret:<name>}\`.\n`,
    );
    return 0;
  }
  const width = Math.max(...stored.map((s) => s.id.length));
  for (const secret of stored) {
    process.stdout.write(`${secret.id.padEnd(width)}  configured\n`);
  }
  // Named, because another checkout of the same repository under a different
  // workspace name has its own and would list nothing here.
  process.stdout.write(
    `\n${stored.length} for \`${workspace}\` in the ${store.description}. ` +
      `Values are never printed.\n`,
  );
  return 0;
}

async function commandDelete(store: SecretStore, name: string | undefined): Promise<number> {
  if (!name) {
    process.stderr.write('Which secret? `statescope secret delete <name>`\n');
    return EXIT_USAGE;
  }
  const removed = await store.delete(name);
  process.stdout.write(removed ? `${name}  deleted\n` : `${name}  was not configured\n`);
  return removed ? 0 : 1;
}

/**
 * The value, from the terminal with echo off, or from a pipe.
 *
 * Never from an argument: a `--value` flag writes the credential into the
 * shell's history file and shows it in `ps`, which are the two places it is
 * hardest to remove from afterwards.
 */
async function readValue(name: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    // One trailing newline is the pipe's, not the value's; anything more is.
    return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
  }

  process.stderr.write(`Value for \`${name}\` (not shown): `);
  const input = process.stdin;
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);

  return new Promise<string | undefined>((resolve) => {
    let value = '';
    const restore = () => {
      input.setRawMode(wasRaw);
      input.removeListener('data', onData);
      input.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        // Ctrl-C and Ctrl-D: leave the terminal as it was found, and store
        // nothing. A half-typed credential is not a credential.
        if (byte === 3 || byte === 4) {
          restore();
          resolve(undefined);
          return;
        }
        if (byte === 13 || byte === 10) {
          restore();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

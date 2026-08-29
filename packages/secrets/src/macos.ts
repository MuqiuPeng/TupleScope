/**
 * macOS Keychain, through `/usr/bin/security`.
 *
 * Two things about that tool shape this implementation, and both were measured
 * rather than assumed.
 *
 * **It reports values in two formats and does not say which.** `find-generic-password -w`
 * prints the value as text when every byte is printable ASCII and as bare
 * hexadecimal when it is not — with no marker. So a stored string `deadbeef`
 * and the stored bytes `de ad be ef` come back identically. The fix is to make
 * the ambiguity impossible instead of guessing at it: what goes into the
 * keychain is **base64 of the UTF-8 value**, which is always printable ASCII,
 * so the value always comes back verbatim and decodes exactly. Verified to
 * round-trip newlines, quotes, backslashes, shell metacharacters, non-ASCII and
 * 200 random bytes.
 *
 * **A value passed as `-w <value>` lands in the process argument list**, where
 * `ps` shows it to every user on the machine. `security -i` reads the same
 * commands from standard input instead, which keeps the value out of `argv`
 * entirely. Base64 has no spaces or quotes, so the line needs no escaping.
 *
 * The ACL prompt never appears here because the process reading an item is the
 * same binary that wrote it.
 */

import { spawn } from 'node:child_process';
import { Secret } from './secret.js';
import {
  assertUsableId,
  assertUsableNamespace,
  qualify,
  unwrap,
  wrap,
  SecretStoreUnavailable,
  SERVICE,
  unqualify,
  type Namespace,
  type SecretId,
  type SecretStore,
  type StoredSecret,
} from './store.js';

/** `security`'s code for "no such item". Used by find and by delete. */
const NOT_FOUND = 44;

/** One account for everything, so the service name alone identifies an item. */
const ACCOUNT = 'tuplescope';

/**
 * The longest value that fits down the safe path.
 *
 * `security -i` reads a 4096-character line and silently mangles anything
 * longer — measured by bisection, the ceiling is between 4082 and 4085 with the
 * rest of the command included. Base64 costs a third, so about three kilobytes
 * of value survive.
 *
 * A longer one is refused rather than sent through `-w`, which would put the
 * credential in the process argument list where `ps` shows it to every user on
 * the machine. Quietly taking the unsafe path for large values would mean the
 * feature's promise held only for values that happened to be short.
 */
const MAX_VALUE_BYTES = 3000;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: ReadonlyArray<string>, stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export class MacOSKeychain implements SecretStore {
  readonly description = 'macOS Keychain';

  /** Every item this instance touches belongs to one workspace. */
  constructor(private readonly namespace: Namespace) {
    assertUsableNamespace(namespace);
  }

  static async probe(namespace: Namespace): Promise<MacOSKeychain> {
    if (process.platform !== 'darwin') {
      throw new SecretStoreUnavailable(
        `this is ${process.platform}, not macOS`,
        'This backend only runs on macOS.',
      );
    }
    // `list-keychains` rather than something that looks more like a health
    // check: `security error 0` prints "No error" and then exits 1.
    const { code, stderr } = await run(['list-keychains']).catch(() => ({
      code: -1,
      stdout: '',
      stderr: 'security could not be started',
    }));
    if (code !== 0) {
      throw new SecretStoreUnavailable(
        `/usr/bin/security did not run (${stderr.trim() || `exit ${code}`})`,
        'Use environment variables, or configure a supported secret backend.',
      );
    }
    return new MacOSKeychain(namespace);
  }

  /** Without `-w`: prints attributes, never decrypts, never prompts. */
  async has(id: SecretId): Promise<boolean> {
    assertUsableId(id);
    const { code } = await run([
      'find-generic-password',
      '-s',
      qualify(this.namespace, id),
      '-a',
      ACCOUNT,
    ]);
    return code === 0;
  }

  async get(id: SecretId): Promise<Secret | undefined> {
    assertUsableId(id);
    const { code, stdout, stderr } = await run([
      'find-generic-password',
      '-s',
      qualify(this.namespace, id),
      '-a',
      ACCOUNT,
      '-w',
    ]);
    if (code === NOT_FOUND) return undefined;
    if (code !== 0) throw failure('read', id, code, stderr);
    return new Secret(unwrap(stdout, id, this.description), id);
  }

  async set(id: SecretId, value: string): Promise<void> {
    assertUsableId(id);
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > MAX_VALUE_BYTES) {
      throw new Error(
        `That value is ${bytes.length} bytes, and the macOS Keychain can only be written ` +
          `safely here up to ${MAX_VALUE_BYTES}. The command-line tool takes a longer value ` +
          `only as a process argument, where \`ps\` would show it to every user on this ` +
          `machine — so this refuses rather than doing that quietly. For something this large, ` +
          `an environment variable read with \`\${VAR}\` is the honest option.`,
      );
    }
    const encoded = wrap(value);
    // Through stdin, not argv: `-w <value>` on the command line is readable by
    // `ps` for the lifetime of the process.
    const { code, stderr } = await run(
      ['-i'],
      `add-generic-password -s ${qualify(this.namespace, id)} -a ${ACCOUNT} -w ${encoded} -U\n`,
    );
    if (code !== 0) throw failure('store', id, code, stderr);
  }

  async delete(id: SecretId): Promise<boolean> {
    assertUsableId(id);
    const { code, stderr } = await run([
      'delete-generic-password',
      '-s',
      qualify(this.namespace, id),
      '-a',
      ACCOUNT,
    ]);
    if (code === NOT_FOUND) return false;
    if (code !== 0) throw failure('delete', id, code, stderr);
    return true;
  }

  /**
   * Only this tool's own items.
   *
   * `dump-keychain` **without** `-d` reports metadata and never asks for
   * permission — the prompt-per-item that makes the flag unusable comes from
   * dumping the data. Filtering on the service prefix is what keeps other
   * applications' credentials out of the listing, which matters: a person
   * running `secret list` must not be shown, or given a way to delete, a
   * password some other program put there.
   */
  async list(): Promise<ReadonlyArray<StoredSecret>> {
    const { code, stdout, stderr } = await run(['dump-keychain']);
    if (code !== 0) throw failure('list', '(all)', code, stderr);
    const ids = new Set<SecretId>();
    for (const match of stdout.matchAll(/"svce"<blob>="((?:[^"\\]|\\.)*)"/g)) {
      const parsed = unqualify(match[1]!.replace(/\\(.)/g, '$1'));
      // Other workspaces' credentials are not this workspace's business, and
      // listing them would offer a way to delete them by mistake.
      if (parsed && parsed.namespace === this.namespace) ids.add(parsed.id);
    }
    return [...ids].sort().map((id) => ({ id }));
  }
}

function failure(action: string, id: SecretId, code: number, stderr: string): Error {
  const detail = stderr.trim() || `exit ${code}`;
  if (/User interaction is not allowed/i.test(stderr)) {
    return new Error(
      `Could not ${action} \`${id}\`: the keychain is locked and cannot ask for the password ` +
        `here. Unlock it in Keychain Access, or run this from a session that has one. (${detail})`,
    );
  }
  if (code === 51 || /denied|authorization/i.test(stderr)) {
    return new Error(
      `Could not ${action} \`${id}\`: the keychain refused access. If a prompt appeared and was ` +
        `dismissed, run the command again and choose Always Allow. (${detail})`,
    );
  }
  return new Error(`Could not ${action} \`${id}\` in the ${SERVICE} keychain items: ${detail}`);
}

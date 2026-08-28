/**
 * Linux Secret Service, through `secret-tool` from libsecret.
 *
 * The thing to know before reading the code: **`secret-tool lookup` cannot tell
 * you why it found nothing.** A genuinely absent item and a keyring that has
 * never had a collection unlocked both give exit 1 with empty stdout and empty
 * stderr. Believing the first meaning produces the worst possible advice on a
 * headless machine — "the secret is not set, go set it" — when setting it will
 * also fail, for a reason nothing has named. That is why availability is
 * established by a round trip rather than by asking.
 *
 * Two more measured details shape this:
 *
 *   `secret-tool` is **absent from every common base image** and is frequently
 *   absent even on a desktop Ubuntu, where libsecret ships without its CLI. Its
 *   presence is checked, not assumed. It has no `--version`.
 *
 *   `secret-tool store` branches on `isatty(0)`: from a terminal it prompts,
 *   and from anything else — every `spawn` — it reads standard input to EOF. So
 *   the value goes on stdin, never as an argument, where `/proc/*​/cmdline`
 *   would make it world-readable.
 *
 * Values are base64-encoded for the same reason as on macOS: it keeps the byte
 * range out of a text channel, and `secret-tool` on recent libsecret refuses
 * non-UTF-8 outright.
 *
 * `secret-tool search` is deliberately not used for listing. It prints the
 * secrets.
 */

import { spawn } from 'node:child_process';
import { Secret } from './secret.js';
import { verifyRoundTrip } from './roundtrip.js';
import {
  assertUsableId,
  assertUsableNamespace,
  SecretStoreUnavailable,
  unwrap,
  wrap,
  SERVICE,
  type Namespace,
  type SecretId,
  type SecretStore,
  type StoredSecret,
} from './store.js';

/** Attributes are positional `name value` pairs; there is no `--attribute` flag. */
const SCHEMA = ['xdg:schema', SERVICE];

const REMEDY =
  'Use environment variables with `${VAR}`, which is also what a CI runner should use. ' +
  'On a desktop, install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch/Alpine) ' +
  'and log in to a session that unlocks the keyring.';

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: ReadonlyArray<string>, stdin?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('secret-tool', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

export class SecretServiceStore implements SecretStore {
  readonly description = 'Secret Service (libsecret)';

  /** Every item this instance touches belongs to one workspace. */
  constructor(private readonly namespace: Namespace) {
    assertUsableNamespace(namespace);
  }

  static async probe(namespace: Namespace): Promise<SecretStore> {
    if (process.platform !== 'linux') {
      throw new SecretStoreUnavailable(`this is ${process.platform}, not Linux`, REMEDY);
    }
    // `secret-tool` has no --version; running it with no arguments prints
    // usage and exits 2, which is enough to know it is there.
    let probe: Ran;
    try {
      probe = await run([]);
    } catch {
      throw new SecretStoreUnavailable(
        '`secret-tool` is not installed. It is absent from every common container image, ' +
          'and on Debian and Ubuntu it lives in `libsecret-tools`, which a desktop install ' +
          'often does not pull in',
        REMEDY,
      );
    }
    void probe;

    // These two are distinguishable by their message and worth naming exactly,
    // because the advice differs: one needs a session bus, the other needs a
    // keyring to exist at all.
    const dry = await run(['lookup', ...SCHEMA, 'name', 'statescope-availability-probe']);
    // Both spellings are real: a desktop with no `$DISPLAY` says the first, and
    // a container — measured on `debian:bookworm-slim` — says the second,
    // because it has no machine-id either. Matching only the documented one
    // would have misread every container as "the secret is not configured".
    if (/Cannot autolaunch D-Bus|without a machine-id/i.test(dry.stderr)) {
      throw new SecretStoreUnavailable(
        'there is no D-Bus session bus here, so no keyring can be reached. This is what a ' +
          'container, an SSH session with no desktop, and WSL2 without systemd all look like',
        REMEDY,
      );
    }
    if (/was not provided by any \.service files/i.test(dry.stderr)) {
      throw new SecretStoreUnavailable(
        'a session bus is running but nothing provides `org.freedesktop.secrets` — no ' +
          'gnome-keyring, KWallet or KeePassXC is available to hold the credential',
        REMEDY,
      );
    }

    // Everything else is indistinguishable by inspection: an empty exit 1 means
    // either "nothing stored" or "no collection unlocked". Only using it tells
    // them apart.
    return verifyRoundTrip(new SecretServiceStore(namespace), REMEDY);
  }

  private attributes(id: SecretId): string[] {
    // `workspace` is an attribute rather than part of `name`, because
    // `secret-tool` matches on attribute sets and this keeps one workspace's
    // items from ever matching another's.
    return [...SCHEMA, 'workspace', this.namespace, 'name', id];
  }

  /**
   * `secret-tool` has no metadata-only read, so this decrypts like `get`.
   *
   * Unlike macOS there is nothing to be gained by avoiding it: libsecret
   * neither prompts per read nor distinguishes the two operations, and by the
   * time any read happens the round-trip probe has already established that
   * the collection is unlocked.
   */
  async has(id: SecretId): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async get(id: SecretId): Promise<Secret | undefined> {
    assertUsableId(id);
    const { code, stdout, stderr } = await run(['lookup', ...this.attributes(id)]);
    if (code !== 0) {
      // Exit 1 with nothing on stderr is the ambiguous case, and by the time a
      // read happens the round trip has already ruled out a locked keyring.
      if (code === 1 && stderr.trim() === '') return undefined;
      throw new Error(`Could not read \`${id}\` from the keyring: ${stderr.trim() || `exit ${code}`}`);
    }
    return new Secret(unwrap(stdout, id, this.description), id);
  }

  async set(id: SecretId, value: string): Promise<void> {
    assertUsableId(id);
    const encoded = wrap(value);
    const { code, stderr } = await run(
      ['store', '--label', `StateScope: ${id}`, ...this.attributes(id)],
      encoded,
    );
    if (code === 0) return;
    if (/prompt|Object does not exist at path/i.test(stderr)) {
      throw new Error(
        `Could not store \`${id}\`: the keyring asked to be unlocked and there is no display ` +
          `to ask on. Unlock it in a desktop session first, or use \`\${VAR}\` here.`,
      );
    }
    throw new Error(`Could not store \`${id}\` in the keyring: ${stderr.trim() || `exit ${code}`}`);
  }

  async delete(id: SecretId): Promise<boolean> {
    assertUsableId(id);
    // `clear` reports success whether or not anything matched, so the only way
    // to answer honestly is to look first.
    const existed = (await this.get(id)) !== undefined;
    const { code, stderr } = await run(['clear', ...this.attributes(id)]);
    if (code !== 0) {
      throw new Error(`Could not delete \`${id}\`: ${stderr.trim() || `exit ${code}`}`);
    }
    return existed;
  }

  /**
   * Not implemented through `secret-tool search`, which prints the secrets it
   * finds. Listing credentials must never be a way to read them.
   */
  async list(): Promise<ReadonlyArray<StoredSecret>> {
    throw new Error(
      `Listing is not available on the Secret Service backend. The only enumeration ` +
        `\`secret-tool\` offers is \`search\`, which prints the values — and a command whose ` +
        `job is to say which secrets exist must not be a way to read them. ` +
        `Use your desktop's keyring application to browse them; ` +
        `\`statescope status\` still reports whether each one a workspace needs is configured.`,
    );
  }
}

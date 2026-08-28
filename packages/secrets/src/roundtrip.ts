/**
 * Proving a store works by using it, instead of by inspecting it.
 *
 * Two backends here cannot be checked any other way.
 *
 * On Linux, `secret-tool lookup` returns exit 1 with empty stdout *and* empty
 * stderr both when nothing is stored under that name and when the keyring is
 * present but no collection has ever been unlocked. A tool that reads the first
 * meaning into the second tells a developer on a headless machine "the secret
 * is not set, run `secret set`" — and that also fails, differently, and the
 * real cause is never named.
 *
 * On Windows, the only way to read a credential back without a native module is
 * PowerShell compiling a P/Invoke shim at runtime. It works on a stock install
 * and it does not work under Constrained Language Mode, under some endpoint
 * protection, or where `powershell.exe` has been removed from PATH — none of
 * which can be detected by asking.
 *
 * So the probe writes a throwaway value, reads it back, and removes it. It
 * costs one round trip when a process first needs a secret, and it is the
 * difference between a backend that works and one that merely appears to.
 */

import { randomBytes } from 'node:crypto';
import { SecretStoreUnavailable, type SecretStore } from './store.js';

/**
 * A value chosen so that a store which silently mangles it is caught: it spans
 * the byte range, includes characters that need escaping in every shell and
 * markup this touches, and is long enough that a truncating store shows it.
 */
function canaryValue(): string {
  return `statescope-probe ${randomBytes(24).toString('base64')} 'q" \\ üñ`;
}

export async function verifyRoundTrip(
  store: SecretStore,
  remedy: string,
): Promise<SecretStore> {
  const id = `probe-${randomBytes(6).toString('hex')}`;
  const value = canaryValue();
  try {
    await store.set(id, value);
  } catch (error) {
    throw new SecretStoreUnavailable(
      `${store.description} would not accept a value (${(error as Error).message})`,
      remedy,
    );
  }

  let read;
  try {
    read = await store.get(id);
  } catch (error) {
    await store.delete(id).catch(() => undefined);
    throw new SecretStoreUnavailable(
      `${store.description} would not return a value it had just stored ` +
        `(${(error as Error).message})`,
      remedy,
    );
  } finally {
    // Always, even if the read threw: a probe that leaves items behind is
    // worse than one that fails.
    await store.delete(id).catch(() => undefined);
  }

  if (!read) {
    throw new SecretStoreUnavailable(
      `${store.description} accepted a value and then reported it missing. On Linux this is ` +
        `what a keyring with no unlocked collection looks like — the read cannot tell it ` +
        `apart from "nothing is stored"`,
      remedy,
    );
  }
  if (read.reveal() !== value) {
    // A store that changes the value is more dangerous than one that fails:
    // the credential would be wrong rather than absent, and the failure would
    // surface as an authentication error nobody would trace back to here.
    throw new SecretStoreUnavailable(
      `${store.description} returned a different value than it was given, so it cannot be ` +
        `trusted with a credential`,
      remedy,
    );
  }
  return store;
}

/**
 * What a credential store has to do, and what it must refuse to pretend.
 *
 * Three implementations are expected — the operating system's own store on
 * macOS, Windows and Linux — and one deliberate non-implementation: where no
 * store is available, this layer *fails*. It does not write the credentials
 * somewhere convenient. A tool whose entire promise is "your credentials are
 * not in the file you commit" cannot keep that promise by quietly inventing a
 * different file to put them in.
 */

import type { Secret } from './secret.js';

/** The name a credential is stored under. Distinct from the logical name a workspace uses. */
export type SecretId = string;

export interface StoredSecret {
  id: SecretId;
  /** Present only where the backend can report it cheaply. */
  updatedAt?: string;
}

export interface SecretStore {
  /** For messages: `macOS Keychain`, `Secret Service (gnome-keyring)`. */
  readonly description: string;

  /**
   * Whether something is stored, **without decrypting it**.
   *
   * Separate from `get` because the difference is not an optimisation. Reading
   * a value is the operation that raises the macOS permission dialog and the
   * one that blocks on a locked keychain — so `tuplescope status`, the command
   * a person runs *because* something is wrong, was the most likely to prompt
   * or hang. It also made this file's own claim that "the value never leaves
   * the keychain" untrue.
   */
  has(id: SecretId): Promise<boolean>;

  /** The value, or `undefined` when nothing is stored under that id. Never throws for absence. */
  get(id: SecretId): Promise<Secret | undefined>;
  set(id: SecretId, value: string): Promise<void>;
  /** True when something was removed, false when there was nothing to remove. */
  delete(id: SecretId): Promise<boolean>;
  /** Everything this tool stored. Other applications' credentials are never listed. */
  list(): Promise<ReadonlyArray<StoredSecret>>;
}

/**
 * Thrown when no store can be used, with the two things a person needs: why,
 * and what to do instead.
 *
 * Deliberately not a fallback. The message names environment variables as the
 * alternative because that is a choice the user makes knowingly, unlike a file
 * appearing on disk on their behalf.
 */
export class SecretStoreUnavailable extends Error {
  constructor(
    readonly reason: string,
    readonly remedy: string,
  ) {
    super(`Secret store unavailable: ${reason}\n${remedy}`);
    this.name = 'SecretStoreUnavailable';
  }
}

/** Thrown when a reference names a secret nothing has been stored under. */
export class SecretNotConfigured extends Error {
  constructor(
    readonly name: string,
    readonly id: SecretId,
    where: string,
  ) {
    super(
      name === id
        ? `The secret \`${name}\` is not configured. Set it with ` +
          `\`tuplescope secret set ${name}\`. (referenced by ${where})`
        : `\`${name}\` resolves to the secret \`${id}\`, which is not configured. ` +
          `Set it with \`tuplescope secret set ${id}\`. (referenced by ${where})`,
    );
    this.name = 'SecretNotConfigured';
  }
}

/**
 * The prefix every stored item carries.
 *
 * One machine holds one keyring shared by everything on it, so an unnamespaced
 * `db_password` would collide with whatever else wanted that name — and `list`
 * would show a person credentials this tool never stored and must not touch.
 */
export const SERVICE = 'dev.tuplescope.secret';

/**
 * Marks a stored blob as one this tool wrote, and in which encoding.
 *
 * Values are base64 so that no byte range can be mangled by a text channel.
 * The consequence, without a marker, is that *anything* in the slot decodes:
 * a credential a person typed into Keychain Access by hand comes back as
 * `Buffer.from('Bearer cus_alice', 'base64')` — eleven bytes of binary — and
 * every check reports it as configured. The API then rejects a credential
 * nobody can see is wrong.
 *
 * With the marker, a foreign item is a sentence instead.
 */
export const ENVELOPE = 'tuplescope.v1:';

export function wrap(value: string): string {
  return ENVELOPE + Buffer.from(value, 'utf8').toString('base64');
}

export function unwrap(stored: string, id: SecretId, where: string): string {
  const trimmed = stored.trim();
  if (!trimmed.startsWith(ENVELOPE)) {
    throw new Error(
      `The item stored for \`${id}\` in the ${where} was not written by TupleScope, so its ` +
        `contents cannot be read reliably. Overwrite it with ` +
        `\`tuplescope secret set ${id}\`, or remove it from the store first.`,
    );
  }
  return Buffer.from(trimmed.slice(ENVELOPE.length), 'base64').toString('utf8');
}

/**
 * Which workspace a stored credential belongs to.
 *
 * Without it, two checkouts on one machine that both refer to `api_token`
 * silently share one value, and the second `set` prints the same success line
 * as the first — neither can be told from a correct setup by looking.
 *
 * Derived from the workspace's own `name`, which is already required and
 * already in the committed file, so every existing workspace gets one with no
 * edit. Reviewable and portable between machines, unlike a path or a host id.
 */
export type Namespace = string;

export const NAMESPACE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertUsableNamespace(namespace: string): void {
  if (NAMESPACE.test(namespace)) return;
  throw new Error(
    `\`${namespace}\` is not a usable secret namespace. Use lower-case letters, digits, ` +
      `underscores and hyphens, starting with a letter or digit, up to 64 characters.`,
  );
}

/** A workspace's `name` as a namespace. Never fails; always produces something usable. */
export function namespaceFor(workspaceName: string): Namespace {
  const slug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return NAMESPACE.test(slug) ? slug : 'workspace';
}

export function qualify(namespace: Namespace, id: SecretId): string {
  return `${SERVICE}.${namespace}.${id}`;
}

/** The namespace and id a stored service name carries, or null when it is not ours. */
export function unqualify(service: string): { namespace: Namespace; id: SecretId } | null {
  if (!service.startsWith(`${SERVICE}.`)) return null;
  const rest = service.slice(SERVICE.length + 1);
  const dot = rest.indexOf('.');
  // Neither part may contain a dot, so the first is the boundary. An item
  // written before namespaces existed has none and is deliberately not
  // claimed: guessing which workspace it belonged to is worse than omitting it.
  if (dot < 0) return null;
  return { namespace: rest.slice(0, dot), id: rest.slice(dot + 1) };
}

/** The shape of a usable id, enforced everywhere a person can supply one. */
export const SECRET_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function assertUsableId(id: string): void {
  if (SECRET_ID.test(id)) return;
  throw new Error(
    `\`${id}\` is not a usable secret name. Use lower-case letters, digits, underscores and ` +
      `hyphens, starting with a letter or digit.`,
  );
}

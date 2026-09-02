/**
 * What the filesystem will and will not promise, by platform.
 *
 * This exists because several places in this codebase write a file at mode
 * `0600` and say, in a comment beside the call, that nothing else on the
 * machine can read it. On POSIX that is true. On Windows it is not: the mode
 * bits are not a permission model there, `fs.chmod` only toggles the read-only
 * attribute, and a file written this way reports `0666`.
 *
 * The protection on Windows is real but comes from somewhere else — the
 * inherited ACL of the user's profile directory — and it is not something this
 * code sets, checks, or can currently claim. Saying which is which, in one
 * place, is better than four tests quietly asserting a property on one platform
 * and being deleted on the other.
 */

/** True where `chmod(0o600)` is a permission the filesystem will enforce. */
export const OWNER_ONLY_MODE_IS_ENFORCED = process.platform !== 'win32';

/**
 * What guards a credential file here, for a message or a disclosure.
 *
 * Deliberately not reassuring on Windows. Until this code sets an ACL itself,
 * the honest statement is that it is relying on a default it did not choose.
 */
export const OWNER_ONLY_BASIS = OWNER_ONLY_MODE_IS_ENFORCED
  ? 'mode 0600, set and verified by this code'
  : 'the inherited ACL of your user profile — Windows ignores the mode bits, ' +
    'and this code does not set an ACL of its own';

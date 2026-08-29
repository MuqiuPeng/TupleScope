/**
 * Windows Credential Manager, through PowerShell and a P/Invoke shim.
 *
 * This is the ugliest backend here, and the reason is worth stating: **nothing
 * shipped with Windows can read a stored password back.** `cmdkey` writes,
 * lists metadata and deletes — the documentation says outright that "passwords
 * are not displayed after they're stored" — and there is no Credential Manager
 * API in the .NET base class library. The only stock path to `CredReadW` is
 * PowerShell compiling a small `DllImport` shim at runtime.
 *
 * That path works on a default install with no administrator rights and no SDK.
 * It also costs a few hundred milliseconds per call, fails under Constrained
 * Language Mode, and is the exact shape endpoint-protection products flag. None
 * of those can be detected by asking, so availability is established by
 * actually storing a value, reading it back and removing it. A backend that
 * cannot prove it works reports itself unavailable rather than failing later
 * with a credential in play.
 *
 * The script is passed as `-EncodedCommand` and the value travels on standard
 * input, never in `argv` — a command line on Windows is readable by any process
 * running as the same user through `Win32_Process.CommandLine`, and is recorded
 * by Sysmon. That is also why `cmdkey /pass:` is unusable even for writing.
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
  type Namespace,
  type SecretId,
  type SecretStore,
  type StoredSecret,
} from './store.js';

const REMEDY =
  'Use environment variables with `${VAR}`. Reading a credential back on Windows needs an ' +
  'Advapi32 call that Node cannot make on its own, and the PowerShell route this uses is ' +
  'not available in every environment.';

/** `TargetName` prefix. `CredEnumerate` filters by prefix plus a single asterisk. */
const TARGET = 'TupleScope_secret_';

/** Documented Win32 codes. The messages are localized; the numbers are not. */
const ERROR_NOT_FOUND = 1168;
const ERROR_NO_SUCH_LOGON_SESSION = 1312;

/**
 * The shim, compiled by PowerShell on each invocation.
 *
 * Everything crosses the boundary as base64 so that a value's bytes never meet
 * PowerShell's quoting rules, its output encoding, or a console code page.
 */
const SHIM = `
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
public static class SsCred {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredReadW")]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredWriteW")]
  private static extern bool CredWrite(ref CREDENTIAL cred, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredDeleteW")]
  private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CredEnumerateW")]
  private static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr creds);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  private static extern void CredFree(IntPtr buf);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags; public uint Type;
    public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }

  public static int Read(string target, out string b64) {
    b64 = null; IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return Marshal.GetLastWin32Error();
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, (int)c.CredentialBlobSize);
      b64 = Convert.ToBase64String(blob);
      return 0;
    } finally { CredFree(p); }
  }

  public static int Write(string target, string b64) {
    var blob = Convert.FromBase64String(b64);
    var c = new CREDENTIAL();
    c.Type = 1;                       // CRED_TYPE_GENERIC
    c.Persist = 2;                    // CRED_PERSIST_LOCAL_MACHINE
    c.TargetName = Marshal.StringToCoTaskMemUni(target);
    c.UserName = Marshal.StringToCoTaskMemUni("tuplescope");
    c.Comment = Marshal.StringToCoTaskMemUni("TupleScope secret referenced from tuplescope.yaml");
    c.CredentialBlob = Marshal.AllocCoTaskMem(blob.Length);
    Marshal.Copy(blob, 0, c.CredentialBlob, blob.Length);
    c.CredentialBlobSize = (uint)blob.Length;
    try { return CredWrite(ref c, 0) ? 0 : Marshal.GetLastWin32Error(); }
    finally {
      Marshal.FreeCoTaskMem(c.TargetName); Marshal.FreeCoTaskMem(c.UserName);
      Marshal.FreeCoTaskMem(c.Comment);    Marshal.FreeCoTaskMem(c.CredentialBlob);
    }
  }

  public static int Delete(string target) {
    return CredDelete(target, 1, 0) ? 0 : Marshal.GetLastWin32Error();
  }

  public static int Enumerate(string filter, out string names) {
    names = ""; uint count; IntPtr p;
    if (!CredEnumerate(filter, 0, out count, out p)) return Marshal.GetLastWin32Error();
    try {
      var found = new System.Collections.Generic.List<string>();
      for (uint i = 0; i < count; i++) {
        var entry = Marshal.ReadIntPtr(p, (int)(i * (uint)IntPtr.Size));
        var c = (CREDENTIAL)Marshal.PtrToStructure(entry, typeof(CREDENTIAL));
        found.Add(Marshal.PtrToStringUni(c.TargetName));
      }
      names = String.Join("\`n", found.ToArray());
      return 0;
    } finally { CredFree(p); }
  }
}
"@
`;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function powershell(body: string, stdin?: string): Promise<Ran> {
  // UTF-16LE then base64 is what -EncodedCommand expects, and it means the
  // script text never meets a shell quoting rule either.
  const encoded = Buffer.from(`${SHIM}\n${body}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

/** `code<TAB>payload`, so an error number and a value share one channel unambiguously. */
function split(stdout: string): { code: number; payload: string } {
  const line = stdout.trim();
  const tab = line.indexOf('\t');
  if (tab < 0) return { code: -1, payload: '' };
  return { code: Number(line.slice(0, tab)), payload: line.slice(tab + 1) };
}

export class WindowsCredentialManager implements SecretStore {
  readonly description = 'Windows Credential Manager';

  /** Every item this instance touches belongs to one workspace. */
  constructor(private readonly namespace: Namespace) {
    assertUsableNamespace(namespace);
  }

  static async probe(namespace: Namespace): Promise<SecretStore> {
    if (process.platform !== 'win32') {
      throw new SecretStoreUnavailable(`this is ${process.platform}, not Windows`, REMEDY);
    }
    let ran: Ran;
    try {
      ran = await powershell(`Write-Output "0\`tok"`);
    } catch {
      throw new SecretStoreUnavailable(
        '`powershell.exe` could not be started, and reading a credential back on Windows ' +
          'has no other route that ships with the system',
        REMEDY,
      );
    }
    if (ran.code !== 0 || split(ran.stdout).payload !== 'ok') {
      throw new SecretStoreUnavailable(
        'PowerShell would not compile the Credential Manager shim. Constrained Language Mode ' +
          `and some endpoint-protection policies both block this. (${ran.stderr.trim() || `exit ${ran.code}`})`,
        REMEDY,
      );
    }
    // Compiling is not working. Only a round trip settles that.
    return verifyRoundTrip(new WindowsCredentialManager(namespace), REMEDY);
  }

  private target(id: SecretId): string {
    return `${TARGET}${this.namespace}_${id}`;
  }

  /** `CredEnumerate` filters by prefix plus one asterisk; nothing else. */
  private get filter(): string {
    return `${TARGET}${this.namespace}_*`;
  }

  /**
   * There is no metadata-only read for a credential blob, so this costs the
   * same PowerShell round trip as `get` and simply discards the value.
   */
  async has(id: SecretId): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async get(id: SecretId): Promise<Secret | undefined> {
    assertUsableId(id);
    const ran = await powershell(
      `$b = $null; $rc = [SsCred]::Read('${this.target(id)}', [ref] $b); Write-Output "$rc\`t$b"`,
    );
    const { code, payload } = split(ran.stdout);
    if (code === ERROR_NOT_FOUND) return undefined;
    if (code !== 0) throw failure('read', id, code, ran);
    return new Secret(unwrap(Buffer.from(payload, 'base64').toString('utf8'), id, this.description), id);
  }

  async set(id: SecretId, value: string): Promise<void> {
    assertUsableId(id);
    // On stdin: a Windows command line is readable by any process of the same
    // user, and Sysmon records it.
    const ran = await powershell(
      `$b64 = [Console]::In.ReadToEnd().Trim()
       $rc = [SsCred]::Write('${this.target(id)}', $b64); Write-Output "$rc\`t"`,
      Buffer.from(wrap(value), 'utf8').toString('base64'),
    );
    const { code } = split(ran.stdout);
    if (code !== 0) throw failure('store', id, code, ran);
  }

  async delete(id: SecretId): Promise<boolean> {
    assertUsableId(id);
    const ran = await powershell(`$rc = [SsCred]::Delete('${this.target(id)}'); Write-Output "$rc\`t"`);
    const { code } = split(ran.stdout);
    if (code === ERROR_NOT_FOUND) return false;
    if (code !== 0) throw failure('delete', id, code, ran);
    return true;
  }

  async list(): Promise<ReadonlyArray<StoredSecret>> {
    const ran = await powershell(
      `$n = ''; $rc = [SsCred]::Enumerate('${this.filter}', [ref] $n); Write-Output "$rc\`t$($n -replace "\`n", '|')"`,
    );
    const { code, payload } = split(ran.stdout);
    // An empty result is reported as ERROR_NOT_FOUND, which is not an error
    // here — a fresh machine with no secrets is an empty list.
    if (code === ERROR_NOT_FOUND) return [];
    if (code !== 0) throw failure('list', '(all)', code, ran);
    const prefix = `${TARGET}${this.namespace}_`;
    return payload
      .split('|')
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ id: name.slice(prefix.length) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

function failure(action: string, id: SecretId, code: number, ran: Ran): Error {
  if (code === ERROR_NO_SUCH_LOGON_SESSION) {
    return new Error(
      `Could not ${action} \`${id}\`: this process has no logon session with a credential ` +
        `store. That is what a service account, a network logon and some CI agents look like. ` +
        `Use \`\${VAR}\` there instead.`,
    );
  }
  const detail = ran.stderr.trim() || `Win32 error ${code}`;
  return new Error(`Could not ${action} \`${id}\` in the Windows Credential Manager: ${detail}`);
}

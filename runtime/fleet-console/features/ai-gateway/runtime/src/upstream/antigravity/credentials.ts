import { spawn } from "node:child_process";
import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  optionalTrimmedString,
  type CredentialMethod,
  type CredentialResolverDeps,
} from "../../transport/credentials.js";

/**
 * The credential the Antigravity CLI (`agy`) and the Antigravity IDE share.
 *
 * Fleet never runs the Antigravity OAuth flow. `agy` owns the login, writes the
 * token, and refreshes it on its own schedule; this module only reads what that
 * CLI left behind. That is also why a silent refresh here is never written back
 * (see {@link resolveAntigravityAuth}).
 *
 * `agy` picks one of two stores per run, so a reader that looks in only one of
 * them reads a signed-in user as signed out. By default it writes the OS
 * credential store through Go's `go-keyring`; it switches to
 * {@link antigravityTokenFilePath} when it detects an SSH session, when a
 * keyring timeout was recorded recently, or when its caller asks (its own log
 * lines, `agy` as of 2026-10-04). Measured 2026-10-05 over SSH on macOS: every
 * run logged "Using file-based token storage because SSH session detected",
 * kept renewing that file, and left no keychain item at all.
 */
export const ANTIGRAVITY_KEYCHAIN_SERVICE = "gemini";
export const ANTIGRAVITY_KEYCHAIN_ACCOUNT = "antigravity";

/**
 * The file store, relative to the home directory. It holds the same JSON the
 * keychain item does, without the `go-keyring` wrapper.
 */
const ANTIGRAVITY_TOKEN_FILE_SEGMENTS = [".gemini", "antigravity-cli", "antigravity-oauth-token"] as const;

function antigravityTokenFilePath(deps: Pick<CredentialResolverDeps, "homedir">): string {
  return path.join(deps.homedir(), ...ANTIGRAVITY_TOKEN_FILE_SEGMENTS);
}

/** `go-keyring` base64-wraps any value containing bytes the OS store rejects. */
const GO_KEYRING_BASE64_PREFIX = "go-keyring-base64:";

/**
 * The Antigravity CLI, which owns both the login and its renewal.
 *
 * Fleet holds no OAuth client of its own. When the stored token has lapsed it
 * runs this CLI's cheapest backend-touching command and re-reads the store: the
 * CLI refreshes its own credential as a side effect (measured 2026-08-22 — one
 * `agy models` moved the stored expiry two hours forward and rotated the access
 * token) and persists it, so the renewal benefits every reader on the machine
 * rather than living in this process. That also keeps Google's public-client id
 * and secret out of this repository entirely.
 */
export const ANTIGRAVITY_CLI_BINARY = "agy";
export const ANTIGRAVITY_CLI_REFRESH_ARGS: readonly string[] = ["models"];

/** Cloud Code Assist, the backend Antigravity turns and quota both answer on. */
export const ANTIGRAVITY_DAILY_API = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_PROD_API = "https://cloudcode-pa.googleapis.com";

/**
 * The IDE fingerprint Cloud Code Assist expects on every call.
 *
 * The platform triple is this host's, not a pinned `windows/amd64`: the header is
 * a client identity, and claiming a platform the process is not running on is a
 * lie the wire has no reason to need. Observed accepted from darwin/arm64 on
 * 2026-08-22 against `streamGenerateContent`, `loadCodeAssist`, and
 * `retrieveUserQuotaSummary`.
 */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";

const ARCH_LABELS: Readonly<Record<string, string>> = Object.freeze({
  x64: "amd64",
  arm64: "arm64",
  ia32: "386",
});

export function antigravityUserAgent(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const osType = platform === "win32" ? "windows" : platform;
  const archLabel = ARCH_LABELS[arch] ?? arch;
  return `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=${osType}; arch=${archLabel}; aidev_client; auth_method=oauth)`;
}

/** Same 60-second early-refresh window OpenUsage and the Antigravity CLI use. */
export const ANTIGRAVITY_REFRESH_BUFFER_MS = 60_000;
/** `agy models` is a network round trip; measured near 3s, bounded well above it. */
const VENDOR_REFRESH_TIMEOUT_MS = 20_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
/**
 * Windows pays for a PowerShell start and a C# compile the other stores do not.
 * Measured near 450ms on this path (2026-08-22); bounded well above it because a
 * cold .NET load makes that figure a floor, not a ceiling.
 */
const WINDOWS_CREDENTIAL_TIMEOUT_MS = 15_000;

const vendorRefreshInFlight = new Map<string, Promise<void>>();

export interface AntigravityCredentials {
  readonly accessToken: string;
  readonly method: CredentialMethod;
  readonly expiresAt?: number;
}

export type AntigravityAuthResult =
  | { readonly status: "ok"; readonly credentials: AntigravityCredentials }
  | { readonly status: "signed_out" }
  | { readonly status: "expired" };

export interface ResolveAntigravityOptions {
  readonly now?: () => number;
  /** After a 401/403, renew even if the local clock still thinks the token is good. */
  readonly forceRefresh?: boolean;
  /** Test seam for the vendor-CLI renewal; production spawns the CLI itself. */
  readonly refreshVendorCredential?: (deps: CredentialResolverDeps) => Promise<void>;
}

interface StoredAntigravityToken {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

function expiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1_000) : Math.round(value);
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(
  source: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = optionalTrimmedString(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Decode whatever `go-keyring` or the token file handed back.
 *
 * `agy` stores `{"token":{"access_token","token_type","refresh_token","expiry"},"auth_method"}`
 * base64-wrapped in the keychain (verified against a live `agy` login, 2026-08-22)
 * and as plain JSON in the file store (2026-10-05). The looser
 * shapes below are the ones OpenUsage found across Antigravity builds; accepting
 * them costs nothing and keeps a build change from reading as a signed-out user.
 */
export function parseAntigravityKeychainValue(raw: string): StoredAntigravityToken | null {
  let body = raw.trim();
  if (body.length === 0) return null;
  if (body.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    try {
      body = Buffer.from(body.slice(GO_KEYRING_BASE64_PREFIX.length), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  if (/^bearer /i.test(body)) body = body.slice(7).trim();
  if (!body.startsWith("{")) {
    // A bare token has no refresh material, so it is usable only until it lapses.
    return body.length > 0 ? { accessToken: body } : null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = credentialRecord(parsed);
  if (!root) return null;
  const source = credentialRecord(root.token)
    ?? credentialRecord(root.tokens)
    ?? credentialRecord(root.oauth)
    ?? credentialRecord(root.oauth2)
    ?? credentialRecord(root.credentials)
    ?? credentialRecord(root.auth)
    ?? root;
  const accessToken = firstString(source, [
    "access_token",
    "accessToken",
    "token",
    "id_token",
    "idToken",
    "bearerToken",
    "auth_token",
    "authToken",
  ]);
  const refreshToken = firstString(source, ["refresh_token", "refreshToken"]);
  const expiresAt = expiry(source.expiry) ?? expiry(source.expires_at) ?? expiry(source.expiresAt);
  if (!accessToken && !refreshToken) return null;
  return {
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * `go-keyring`'s Windows backend stores one Credential Manager generic item named
 * `service:account`, so this names the same secret macOS and Linux reach through
 * their own store's addressing.
 */
const WINDOWS_CREDENTIAL_TARGET = `${ANTIGRAVITY_KEYCHAIN_SERVICE}:${ANTIGRAVITY_KEYCHAIN_ACCOUNT}`;

/**
 * Read one Credential Manager item and print its blob as base64.
 *
 * Windows ships no shell tool that prints a generic credential's value, which is
 * why this declares `CredReadW` and calls it rather than shelling out to one. Two
 * choices here are deliberate: the blob is emitted base64 because the console code
 * page would otherwise decide how `go-keyring`'s UTF-8 bytes come out, and base64
 * is ASCII under every page; and an absent item prints nothing and exits 0, since
 * "not signed in" is a fact to report, not a failure to raise.
 */
const WINDOWS_CREDENTIAL_READER = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FleetAntigravityCredential {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CredReadW")]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static string Read(string target) {
    IntPtr handle;
    if (!CredRead(target, 1, 0, out handle)) return "";
    try {
      CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(handle, typeof(CREDENTIAL));
      byte[] blob = new byte[cred.CredentialBlobSize];
      Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
      return Convert.ToBase64String(blob);
    } finally { CredFree(handle); }
  }
}
'@
[Console]::Out.Write([FleetAntigravityCredential]::Read('${WINDOWS_CREDENTIAL_TARGET}'))
`;

/**
 * PowerShell by absolute path, never by name.
 *
 * This runs with the caller's `PATH`, and a credential reader is the last place to
 * let `PATH` order pick which binary sees the secret. The bare name stays only as
 * the fallback for a host that hid `SystemRoot`.
 */
function windowsPowerShell(deps: CredentialResolverDeps): string {
  const systemRoot = optionalTrimmedString(deps.env.SystemRoot);
  return systemRoot === undefined
    ? "powershell.exe"
    : path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Read the OS credential store `go-keyring` wrote into.
 *
 * Each branch reads the store `go-keyring` itself selects for that platform: the
 * keychain on macOS, libsecret through `secret-tool` on Linux, and the Credential
 * Manager on Windows. Anything else has no store to read and reports absent rather
 * than pretending to have looked.
 */
async function readKeychainValue(deps: CredentialResolverDeps): Promise<string | null> {
  if (deps.platform === "darwin") {
    const raw = await deps.execFile(
      "security",
      [
        "find-generic-password",
        "-s",
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        "-a",
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return raw.length > MAX_CREDENTIAL_BYTES ? null : raw;
  }
  if (deps.platform === "linux") {
    const raw = await deps.execFile(
      "secret-tool",
      [
        "lookup",
        "service",
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        "username",
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
      ],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    return raw.length > MAX_CREDENTIAL_BYTES ? null : raw;
  }
  if (deps.platform === "win32") {
    const encoded = await deps.execFile(
      windowsPowerShell(deps),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        // `-EncodedCommand` takes UTF-16LE base64, which is what keeps a script
        // full of quotes and `$` out of Windows command-line quoting entirely.
        Buffer.from(WINDOWS_CREDENTIAL_READER, "utf16le").toString("base64"),
      ],
      { timeout: WINDOWS_CREDENTIAL_TIMEOUT_MS },
    );
    const blob = encoded.trim();
    if (blob.length === 0) return null;
    const raw = Buffer.from(blob, "base64").toString("utf8");
    return raw.length > MAX_CREDENTIAL_BYTES ? null : raw;
  }
  return null;
}

/**
 * Run the vendor CLI far enough that it renews its own stored credential.
 *
 * **stdin must be closed, not piped.** `agy` blocks forever on an open stdin
 * pipe: measured 2026-08-22, `stdio: ["pipe", ...]` produced no output and had
 * to be killed at 12s, while `stdio: "ignore"` finished in about 3s with exit 0.
 * That is why this spawns directly instead of reusing the shared `execFile`
 * credential seam, which captures output and therefore always pipes stdin.
 *
 * Output is discarded — the renewal is a side effect on the credential store,
 * and the caller re-reads that store rather than parsing anything here.
 */
function spawnVendorRefresh(deps: CredentialResolverDeps): Promise<void> {
  const binary = optionalTrimmedString(deps.env.FLEET_ANTIGRAVITY_CLI) ?? ANTIGRAVITY_CLI_BINARY;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...ANTIGRAVITY_CLI_REFRESH_ARGS], { stdio: "ignore", windowsHide: true });
    } catch {
      // An absent CLI is indistinguishable from one that cannot renew.
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, VENDOR_REFRESH_TIMEOUT_MS);
    child.once("error", finish);
    child.once("close", finish);
  });
}

/**
 * Single-flight the renewal.
 *
 * A Console can probe quota and open a turn at the same moment, and two
 * concurrent `agy` runs would race each other's write to one keychain item.
 */
async function runVendorRefresh(
  deps: CredentialResolverDeps,
  refresh: (deps: CredentialResolverDeps) => Promise<void>,
): Promise<void> {
  const binary = optionalTrimmedString(deps.env.FLEET_ANTIGRAVITY_CLI) ?? ANTIGRAVITY_CLI_BINARY;
  const key = `${binary}\u0000${deps.homedir()}`;
  const existing = vendorRefreshInFlight.get(key);
  if (existing) return existing;
  const task = refresh(deps)
    .catch(() => undefined)
    .finally(() => {
      vendorRefreshInFlight.delete(key);
    });
  vendorRefreshInFlight.set(key, task);
  return task;
}

/** A decoded token and the store it came from. */
interface StoredAntigravityCredential {
  readonly token: StoredAntigravityToken;
  readonly method: CredentialMethod;
}

async function readStore(
  method: CredentialMethod,
  readRaw: () => Promise<string | null>,
): Promise<StoredAntigravityCredential | null> {
  let raw: string | null;
  try {
    raw = await readRaw();
  } catch {
    // A missing item or file, a locked keychain, and an absent `secret-tool` all
    // land here; none of them is distinguishable from "not signed in" to a reader.
    return null;
  }
  const token = raw === null ? null : parseAntigravityKeychainValue(raw);
  return token ? { token, method } : null;
}

/**
 * Read both stores `agy` may have written and keep the fresher one.
 *
 * `agy` renews only the store it chose for that run, so when both hold a token
 * the later expiry is the live session and the other is what an earlier run,
 * under the other choice, left behind.
 */
async function readStoredCredential(deps: CredentialResolverDeps): Promise<StoredAntigravityCredential | null> {
  const [keychain, file] = await Promise.all([
    readStore("keychain", () => readKeychainValue(deps)),
    readStore("file", () => deps.readBounded(antigravityTokenFilePath(deps), MAX_CREDENTIAL_BYTES)),
  ]);
  if (!keychain || !file) return keychain ?? file;
  const rank = (stored: StoredAntigravityCredential): number =>
    stored.token.expiresAt ?? Number.NEGATIVE_INFINITY;
  return rank(file) > rank(keychain) ? file : keychain;
}

/**
 * Resolve the Antigravity credential `agy` owns.
 *
 * Fleet reads these stores and never writes them. A lapsed token is renewed by
 * asking the vendor CLI to renew it — Fleet holds no OAuth client, mints no
 * token, and takes no part in a read-modify-write race over the stored
 * credential. The CLI persists what it renews, so the next reader on the
 * machine, Fleet or otherwise, sees the fresh value too.
 */
export async function resolveAntigravityAuth(
  deps: CredentialResolverDeps,
  options: ResolveAntigravityOptions = {},
): Promise<AntigravityAuthResult> {
  const now = options.now ?? Date.now;

  const usable = ({ token, method }: StoredAntigravityCredential): AntigravityAuthResult | null => {
    if (!token.accessToken) return null;
    if (token.expiresAt !== undefined && token.expiresAt <= now()) return null;
    return {
      status: "ok",
      credentials: {
        accessToken: token.accessToken,
        method,
        ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
      },
    };
  };

  const stored = await readStoredCredential(deps);
  if (!stored) return { status: "signed_out" };

  const stale = stored.token.expiresAt !== undefined
    && stored.token.expiresAt - now() <= ANTIGRAVITY_REFRESH_BUFFER_MS;
  if (options.forceRefresh !== true && !stale) {
    const ready = usable(stored);
    if (ready) return ready;
  }

  // Nothing here can renew the session on its own, so a store with no refresh
  // token is simply what it says it is rather than something to retry.
  if (!stored.token.refreshToken) {
    return usable(stored) ?? { status: stored.token.accessToken ? "expired" : "signed_out" };
  }

  await runVendorRefresh(deps, options.refreshVendorCredential ?? spawnVendorRefresh);
  // The CLI inherits this process's environment and may renew the other store
  // than the one just read, so both are read again.
  const renewed = await readStoredCredential(deps);
  const ready = renewed ? usable(renewed) : null;
  if (ready) return ready;
  // The CLI ran and the stored token is still lapsed: the session itself is
  // dead, and only a fresh sign-in can revive it.
  return { status: "expired" };
}

export async function resolveAntigravityCredentials(
  deps: CredentialResolverDeps,
  options: ResolveAntigravityOptions = {},
): Promise<AntigravityCredentials | null> {
  const result = await resolveAntigravityAuth(deps, options);
  return result.status === "ok" ? result.credentials : null;
}

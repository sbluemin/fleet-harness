import path from "node:path";

import {
  MAX_CREDENTIAL_BYTES,
  credentialRecord,
  optionalTrimmedString,
  type CredentialMethod,
  type CredentialResolverDeps,
} from "../../transport/credentials.js";

export interface CursorCredentials {
  readonly accessToken: string;
  readonly method: CredentialMethod;
}

function parseCursorCredentialJson(raw: string, method: CredentialMethod): CursorCredentials | null {
  if (raw.length > MAX_CREDENTIAL_BYTES) return null;
  try {
    const parsed = credentialRecord(JSON.parse(raw));
    if (!parsed) return null;
    const tokens = credentialRecord(parsed.tokens);
    const cursorAuth = credentialRecord(parsed.cursorAuth);
    const accessToken = [
      parsed.accessToken,
      parsed.access_token,
      tokens?.accessToken,
      tokens?.access_token,
      cursorAuth?.accessToken,
      cursorAuth?.access_token,
    ].map(optionalTrimmedString).find((value) => value !== undefined);
    return accessToken ? { accessToken, method } : null;
  } catch {
    return null;
  }
}

/**
 * The auth file Cursor's CLI/IDE login writes, per platform. macOS keeps the
 * token in the keychain and uses this only as a fallback; on Linux and Windows
 * it is the sole source, so skipping it is what produced a 401 there.
 */
export function cursorAuthFilePath(deps: CredentialResolverDeps): string {
  const home = deps.homedir();
  if (deps.platform === "win32") {
    return path.join(deps.env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "auth.json");
  }
  if (deps.platform === "darwin") {
    return path.join(home, ".cursor", "auth.json");
  }
  return path.join(deps.env.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor", "auth.json");
}

export async function resolveCursorCredentials(deps: CredentialResolverDeps): Promise<CursorCredentials | null> {
  if (deps.platform === "darwin") {
    try {
      const raw = await deps.execFile(
        "security",
        ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
        { timeout: 5_000 },
      );
      const accessToken = raw.length <= MAX_CREDENTIAL_BYTES ? optionalTrimmedString(raw) : undefined;
      if (accessToken) return { accessToken, method: "keychain" };
    } catch {
      // The auth file is the required macOS fallback.
    }
  }
  try {
    const raw = await deps.readBounded(cursorAuthFilePath(deps), MAX_CREDENTIAL_BYTES);
    return raw === null || raw.length > MAX_CREDENTIAL_BYTES
      ? null
      : parseCursorCredentialJson(raw, "file");
  } catch {
    return null;
  }
}

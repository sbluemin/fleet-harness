import type { AuthService, AuthStorageEntry } from "../../auth/types.js";
import { MUSE_CODE_AUTH_PROVIDER_ID } from "./config.js";

export interface MuseCodeAuthEntry extends AuthStorageEntry {
  readonly type: "oauth-device";
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly accessExpiresAt?: number;
  readonly mintedAt: number;
  readonly version: 1;
}
export type MuseCodeAuthResult =
  | { readonly status: "ok"; readonly credentials: { readonly apiKey: string; readonly baseUrl?: string } }
  | { readonly status: "signed_out" | "expired" | "unavailable" };

/** Console 슬롯만 읽는다. CLI 파일·환경변수·OS 비밀 저장소에는 접근하지 않는다. */
export async function readMuseCodeEntry(authService: Pick<AuthService, "getEntry">): Promise<MuseCodeAuthEntry | undefined> {
  const entry = await authService.getEntry(MUSE_CODE_AUTH_PROVIDER_ID);
  if (entry === undefined) return undefined;
  if (entry.type !== "oauth-device" || entry.version !== 1
    || typeof entry.key !== "string" || !entry.key.trim()
    || typeof entry.accessToken !== "string" || !entry.accessToken.trim()
    || typeof entry.mintedAt !== "number" || !Number.isFinite(entry.mintedAt)
    || (entry.baseUrl !== undefined && typeof entry.baseUrl !== "string")
    || (entry.accessExpiresAt !== undefined && (typeof entry.accessExpiresAt !== "number" || !Number.isFinite(entry.accessExpiresAt)))) {
    throw new Error("The saved Muse Code sign-in could not be read. Sign in again in Console.");
  }
  return entry as MuseCodeAuthEntry;
}

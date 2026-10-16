import { parseMuseCodeUsage, type ParsedMuseCodeUsage } from "../../upstream/muse-code/quota.js";
import { httpsUrl, OAuthRequestError, requestOAuthJson } from "../device-code.js";
import { MUSE_CODE_KEY_URL } from "./config.js";

export type MuseCodeMintResult =
  | { readonly status: "ok"; readonly apiKey: string; readonly baseUrl?: string; readonly usage: ParsedMuseCodeUsage | null }
  | { readonly status: "expired" }
  | { readonly status: "entitlement_required"; readonly actionUrl?: string };

/** Meta 계정 상태를 바꾸는 onboard 필드는 보내지 않는다. 응답에서 비밀과 사용량만 선별한다. */
export async function mintMuseCodeKey(deps: {
  readonly accessToken: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<MuseCodeMintResult> {
  const { status, body } = await requestOAuthJson(deps.fetch ?? fetch, MUSE_CODE_KEY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json", "Content-Type": "application/json",
      Authorization: `Bearer ${deps.accessToken}`, "x-api-version": "1.0.0",
    },
    body: "{}", ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (status === 401 || status === 403) return { status: "expired" };
  const actionUrl = httpsUrl(body.action_url);
  if ((status >= 200 && status < 300) && (body.is_subs_active === false || body.require_payment === true || actionUrl)) {
    return { status: "entitlement_required", ...(actionUrl ? { actionUrl } : {}) };
  }
  if (status !== 200 || typeof body.api_key !== "string" || !body.api_key.trim()) throw new OAuthRequestError(status);
  // API 키를 다른 origin으로 보내지 않는다. base_url은 저장하되 Meta Model API만 허용한다.
  const baseUrl = httpsUrl(body.base_url);
  if (body.base_url !== undefined && (!baseUrl || new URL(baseUrl).origin !== "https://api.meta.ai")) throw new OAuthRequestError();
  return { status: "ok", apiKey: body.api_key, ...(baseUrl ? { baseUrl } : {}), usage: parseMuseCodeUsage(body) };
}

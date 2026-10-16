import type { DeviceCodeConfig } from "../device-code.js";

export const MUSE_CODE_AUTH_PROVIDER_ID = "Fleet AI Gateway with Muse Code";
export const MUSE_CODE_KEY_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_CODE_DEVICE_CONFIG: DeviceCodeConfig = {
  authorizationUrl: "https://auth.meta.com/oidc/device/authorization/",
  tokenUrl: "https://auth.meta.com/oidc/device/token/",
  clientId: "1031625952748946",
  headers: { "x-api-version": "1.0.0" },
};

/** 조회·재mint가 같은 key endpoint를 공유한다. 강제 새로고침도 이 간격·실패 backoff를 넘지 못한다. */
export const MUSE_CODE_MINT_INTERVAL_MS = 60_000;
export const MUSE_CODE_MINT_BACKOFF_MS = 5 * 60_000;

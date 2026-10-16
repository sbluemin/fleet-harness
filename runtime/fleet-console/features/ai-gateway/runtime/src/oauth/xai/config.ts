import type { DeviceCodeConfig } from "../device-code.js";

export const XAI_AUTH_PROVIDER_ID = "Fleet AI Gateway with xAI";
/** Grok CLI의 공개 client id. 다른 id는 `unauthorized_client`로 거절된다. */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** OIDC discovery가 알려 주는 token endpoint를 고정한다. 발견 문서를 매번 따라가지 않는다. */
export const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DEVICE_CONFIG: DeviceCodeConfig = {
  authorizationUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: XAI_OAUTH_TOKEN_URL,
  clientId: XAI_OAUTH_CLIENT_ID,
  scope: "openid profile email offline_access grok-cli:access api:access",
};
/** 수명 정보가 없는 access token에 둘 만료. */
export const XAI_FALLBACK_ACCESS_TTL_MS = 3_600_000;

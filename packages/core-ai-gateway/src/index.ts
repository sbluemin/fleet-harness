// Compatibility-only facade. Provider branching and behavior live in the provider
// folders; this file only re-exports the public surface from their new locations.
export * from "./anthropic/index.js";
export * from "./canonical/index.js";
export * from "./cursor/index.js";
export * from "./transport/credentials.js";
// wireLog/logCanonicalEvents 는 진단 구현 세부사항이므로 런타임 제어 표면만 좁게 공개한다.
export { DEFAULT_WIRE_LOG_MAX_BYTES, setWireLogTarget, wireLogEnabled } from "./transport/wire-log.js";
export type { WireLogTarget } from "./transport/wire-log.js";
// token-estimate.js 는 의도적으로 배럴 밖이다 — estimateTokens 는 이 패키지가 요청을
// 내보내기 전에 쓰는 내부 휴리스틱이고, 올리면 공개 계약이 넓어진다.
export { AnthropicMessagesGateway, ContextWindowExceededError } from "./anthropic/gateway.js";
export type { AnthropicGatewayCallOptions, AnthropicGatewayResponse } from "./anthropic/gateway.js";
export * from "./models.js";
export * from "./settings/index.js";
export * from "./settings/store.js";
export * from "./opencode-go/index.js";
export * from "./codex/index.js";
export * from "./kimi/index.js";
export * from "./transport/sse-keepalive.js";

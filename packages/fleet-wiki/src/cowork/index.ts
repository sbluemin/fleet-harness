// Cowork 서브패키지 — 터미널 없는 AI 위키 편집 엔진.
// 호스트(Fleet Console 등)는 HTTP/SSE 어댑터만 소유하고 이 엔진을 소비한다.
export * from "./types.js";
export { CoworkStore } from "./store.js";
export { CoworkService } from "./service.js";
export type { CoworkConnector } from "./service.js";
export { createCoworkMcpRuntime } from "./runtime.js";

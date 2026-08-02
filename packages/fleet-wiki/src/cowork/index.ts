// Cowork 서브패키지 — 터미널 없는 AI 위키 편집 엔진.
// 호스트(Fleet Console 등)는 HTTP/SSE 어댑터만 소유하고 이 엔진을 소비한다.
// COWORK_SYSTEM_PROMPT 는 엔진 내부 값이다 — 구 배럴이 공개하던 DTO 타입만 올린다.
export type {
  CoworkAnnotationDto,
  CoworkEventDto,
  CoworkSessionDto,
  CoworkSessionRecord,
  CoworkStoredEvent,
  CoworkTranscriptTurn,
} from "./store.js";
export { CoworkStore } from "./store.js";
export { CoworkService, createCoworkMcpRuntime } from "./service.js";
export type { CoworkAgentClient, CoworkConnectOptions, CoworkConnector } from "./service.js";

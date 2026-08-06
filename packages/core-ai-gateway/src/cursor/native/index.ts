// CursorAdapter만 공개한다. exec-policy와 unknown-exec는 Cursor 내부 정책 모듈로
// 패키지 루트 facade에서 노출하지 않는다 — 테스트는 상대 경로로 직접 import한다.
export * from "./adapter.js";

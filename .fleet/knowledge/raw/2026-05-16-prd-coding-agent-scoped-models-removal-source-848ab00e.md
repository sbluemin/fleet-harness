/scoped-models 제거 사양 — 제거 대상·보존 대상·검증 기준 정리

@sbluemin/fleet-coding-agent에서 모델 관리 복잡성을 줄이기 위해 전용 /scoped-models 기능군을 제거합니다.
- 제거 대상: /scoped-models 슬래시 명령, 전용 선택기 UI, 관련 단축키(Ctrl+S, Ctrl+A, Ctrl+X, Alt+Up/Down).
- 보존 대상: 메인 에디터 모델 사이클링(Ctrl+P/Shift+Ctrl+P), --models CLI 플래그, /model 명령.
- 검증 기준: 명령 미노출, UI 진입 불가, 단축키 무동작, 기존 사이클링 유지 여부.
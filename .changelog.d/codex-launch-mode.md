---
section: Added
---

- [fleet-console] Add an ACP | App Server click toggle on the Codex row in Settings > Agent CLI; the choice persists in ~/.fleet/settings.json as codexLaunchMode and defaults to ACP.
  ko: Settings > Agent CLI의 Codex 행에 ACP | App Server 클릭 토글을 추가하며, 선택값은 ~/.fleet/settings.json의 codexLaunchMode로 영속되고 기본값은 ACP입니다.
- [core-infra] Persist codexLaunchMode (acp or app-server) in ~/.fleet/settings.json global options.
  ko: 전역 옵션 ~/.fleet/settings.json에 codexLaunchMode(acp 또는 app-server)를 영속합니다.
- [core-unified-agent] Route Codex carrier sessions through ACP or legacy App Server based on the CODEX_USE_ACP runtime environment toggle, defaulting to ACP when unset.
  ko: CODEX_USE_ACP 런타임 환경변수 토글에 따라 Codex 캐리어 세션을 ACP 또는 레거시 App Server로 연결하며, 미설정 시 기본값은 ACP입니다.
- [fleet-admiral] [fleet-cli] Apply the saved codexLaunchMode as CODEX_USE_ACP when launching new Codex carrier sessions.
  ko: 새 Codex 캐리어 세션을 시작할 때 저장된 codexLaunchMode를 CODEX_USE_ACP로 적용합니다.

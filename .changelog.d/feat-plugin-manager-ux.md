---
branch: feat/plugin-manager-ux
---

### fleet-console
#### Added
- Sign in to OAuth MCP servers and configure API keys directly for global plugins, with inline connection controls across global, Commodore, and plugin detail views.
  ko: 전역 플러그인에서도 MCP OAuth 로그인과 API 키 설정을 직접 할 수 있으며, 전역·사령관·플러그인 상세 화면에서 바로 연결 상태를 제어할 수 있습니다.

#### Changed
- Redesign the plugin manager with contextual search and filtering in the main pane, explicit marketplace toggles and browse links, component badges, and progressive "Show more" catalog expansion.
  ko: 플러그인 관리 화면의 검색·필터를 우측 본문 맥락에 맞게 재배치하고, 명시적 마켓플레이스 스위치·목록 바로가기·구성 요소 배지·더 보기 확장을 추가했습니다.
- Keep only `claude-plugins-official` and `claude-community` as included default marketplaces, while preserving previously installed plugins from retired presets as removable custom marketplaces.
  ko: 기본 제공 마켓플레이스를 `claude-plugins-official`과 `claude-community`만 남기고, 기존 퇴역 마켓플레이스에서 이미 설치해 둔 플러그인은 제거 가능한 일반 마켓플레이스로 유지합니다.

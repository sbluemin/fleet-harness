---
branch: codex-computer-use-experiment
---

### fleet-console
#### Added
- Add Computer Use for local macOS Agents through a compatible codex CLI and native runtime, with opt-in under experimental AI extensions in Settings, searchable app targets, reusable action schemas, session-scoped access, and actionable status and recovery guidance. Tools stay available while authorization is checked per Operation at call time. Caption and sidebar badges show actual Console Use and Computer Use sessions rather than permission settings; console_end and computer_end end their respective sessions.
  ko: 호환 codex CLI와 native 런타임을 통해 로컬 macOS 에이전트가 앱을 읽고 조작하는 Computer Use를 추가했습니다. Settings의 실험 기능 내 AI 확장에서 켤 수 있으며, 앱 대상 검색·동작 스키마 재사용·세션별 접근과 상태·복구 안내를 제공합니다. 도구는 계속 제공하며 실행 허용은 호출 시점에 Operation별로 검사합니다. 캡션과 사이드바 배지는 허용 설정이 아닌 실제 Console Use·Computer Use 세션을 표시하고, console_end와 computer_end는 각 사용 세션을 종료합니다.

### fleet-desktop
#### Added
- Support macOS automation permission for Computer Use and automatically preview the agent-selected app window inside its Operation. The video-only card highlights on hover, can be dragged, resized, or maximized within the panel, supports floating chat windows, and stops sharing when Computer Use ends; screen recording permission is required, and preview video is not recorded or uploaded.
  ko: Computer Use를 위한 macOS 자동화 권한을 지원하고 에이전트가 선택한 앱 창을 해당 Operation 안에 자동으로 미리 표시합니다. 영상 전용 카드는 마우스를 올리면 강조되고 패널 안에서 드래그·크기 조절·최대화할 수 있습니다. 별도 떠 있는 채팅방 창도 지원하며, Computer Use 종료 시 공유도 중지됩니다. 화면 기록 권한이 필요하며 미리보기 영상은 녹화하거나 업로드하지 않습니다.

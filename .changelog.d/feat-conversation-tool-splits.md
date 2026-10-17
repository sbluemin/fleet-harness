---
branch: feat/conversation-tool-splits
---

### fleet-console
#### Changed
- Files, Repository, Shell, Codex, Skills, and the Fleet Browser now open as split panels beside each commodore or commander conversation instead of borrowing the right sidebar or covering the conversation. Each conversation keeps its own panels and layout, even after a restart, and its tools start from where that conversation works, including its worktree.
  ko: 파일·저장소·Shell·Codex·스킬·플릿 브라우저가 이제 오른쪽 사이드바를 빌리거나 대화를 덮지 않고, 사령관·지휘관 대화마다 옆에 분할 패널로 열립니다. 대화마다 열린 패널과 배치가 따로 남고 다시 시작해도 유지되며, 도구는 그 대화가 일하는 위치(워크트리 포함)에서 시작합니다.
- Each conversation now has its own Shell; closing it ends that Shell and asks first while a command is still running.
  ko: 이제 대화마다 Shell이 따로 있습니다. Shell을 닫으면 그 Shell이 끝나고, 명령이 돌고 있으면 먼저 묻습니다.

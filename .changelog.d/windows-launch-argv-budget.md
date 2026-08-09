---
branch: windows-launch-argv-budget
---

### fleet-cli
#### Fixed
- Refuse a launch on Windows when its arguments do not fit the command line Claude Code starts with, naming the size it reached and the limit it passed, instead of failing at process start with no explanation. Arguments passed through to Claude Code count toward that limit.
  ko: Windows에서 실행 인자가 Claude Code를 띄우는 명령줄에 들어가지 않으면, 프로세스 시작 단계에서 설명 없이 실패하는 대신 도달한 크기와 넘긴 상한을 밝히며 거부합니다. Claude Code로 넘겨주는 인자도 그 상한에 포함됩니다.

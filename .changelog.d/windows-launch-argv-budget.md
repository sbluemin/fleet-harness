---
branch: windows-launch-argv-budget
---

### fleet-cli
#### Fixed
- Refuse a launch on Windows when its arguments do not fit the command line Claude Code starts with, naming the size it reached and the limit it passed, instead of failing at process start with no explanation. Arguments passed through to Claude Code count toward that limit.
  ko: Windows에서 실행 인자가 Claude Code를 띄우는 명령줄에 들어가지 않으면, 프로세스 시작 단계에서 설명 없이 실패하는 대신 도달한 크기와 넘긴 상한을 밝히며 거부합니다. Claude Code로 넘겨주는 인자도 그 상한에 포함됩니다.

### fleet-console
#### Added
- Refuse a launch on Windows when the prompt does not fit the command line the agent starts with, and say how many characters to cut, rather than letting the launch die with no usable reason. The whole command line is measured, so a prompt that fits on its own is still refused when the arguments around it leave no room.
  ko: Windows에서 프롬프트가 에이전트를 띄우는 명령줄에 들어가지 않으면 실행을 거부하고 몇 글자를 줄여야 하는지 알려 줍니다. 이유를 알 수 없는 실패로 끝나지 않습니다. 명령줄 전체를 재므로, 프롬프트만으로는 들어가도 주변 인자가 자리를 남기지 않으면 거부합니다.

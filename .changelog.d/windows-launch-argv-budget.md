---
branch: windows-launch-argv-budget
---

### fleet-console
#### Added
- Refuse a launch on Windows when the prompt does not fit the command line the agent starts with, and say how many characters to cut, rather than letting the launch die with no usable reason. The whole command line is measured, so a prompt that fits on its own is still refused when the arguments around it leave no room.
  ko: Windows에서 프롬프트가 에이전트를 띄우는 명령줄에 들어가지 않으면 실행을 거부하고 몇 글자를 줄여야 하는지 알려 줍니다. 이유를 알 수 없는 실패로 끝나지 않습니다. 명령줄 전체를 재므로, 프롬프트만으로는 들어가도 주변 인자가 자리를 남기지 않으면 거부합니다.

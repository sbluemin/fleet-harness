---
branch: operation-runtime-axis
---

### fleet-console
#### Fixed
- An Operation running in the chat view no longer reads as dormant. Closing the terminal ended the panel's only source of activity, so the sidebar said the session was asleep while the chat strip said it was working. Chat now reports its own turns, and the sidebar shows the same running, waiting, or idle signal the terminal view shows, with a small CHAT mark on the chip naming which surface it runs on.
  ko: 채팅 뷰로 도는 Operation이 더 이상 휴면으로 보이지 않습니다. 터미널을 닫으면 패널의 유일한 활동 신호원이 끊겨, 채팅 스트립은 작업 중이라 말하는데 사이드바는 세션이 잠들었다고 말했습니다. 이제 채팅이 자기 턴을 직접 보고하며, 사이드바는 터미널 뷰와 같은 실행·대기·유휴 신호를 보여주고 칩에 붙는 작은 CHAT 표식이 어느 표면으로 도는지 알려줍니다.
- The Console no longer presents a guess as an activity state. When it cannot reach the source of that signal it says so in a banner and leaves the chips as they were, instead of quietly showing every Operation as idle.
  ko: Console이 더 이상 추측을 활동 상태로 제시하지 않습니다. 그 신호의 원천에 닿지 못하면 배너로 그렇게 말하고 칩은 그대로 두며, 모든 Operation을 조용히 유휴로 보여주지 않습니다.

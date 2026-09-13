---
branch: caption-use-glyphs
---

### fleet-console
#### Changed
- Move the per-Operation experiment switches out of the caption band and into the Operation menu: the caption's ... button, the sidebar right-click and a War Room card now open the same "AI extensions" section, where Watch this session, Console use and Computer Use each show whether they are on and what that allows. The caption keeps only the Session Analyst and view controls, and the Console use mark is redrawn as a window whose corner a pointer takes, the shared shape for every "use" capability.
  ko: Operation별 실험 스위치를 캡션 밴드에서 Operation 메뉴로 옮깁니다. 캡션의 ... 버튼, 사이드바 우클릭, War Room 카드가 같은 「AI 확장」 섹션을 열고, 그 안에서 이 세션 관찰·콘솔 사용·컴퓨터 사용이 각각 켜져 있는지와 무엇을 허용하는지를 보여 줍니다. 캡션에는 Session Analyst와 보기 제어만 남고, 콘솔 사용 표식은 포인터가 창의 모서리를 무는 모양으로 다시 그려 모든 「사용」 기능이 같은 형태를 공유합니다.
#### Added
- Computer Use follows the same per-Operation policy as Console use: the Experiments switch alone allows nothing, every device tool call is refused until you allow that Operation from its menu, allowing or revoking applies to the next call without restarting or reconnecting, a refusal tells the agent which switch is off and where to turn it on, and revoking releases the device session that Operation was holding.
  ko: 컴퓨터 사용이 콘솔 사용과 같은 Operation별 정책을 따릅니다. 실험 기능 스위치만으로는 아무것도 허용되지 않고, 그 Operation을 메뉴에서 허용하기 전까지 모든 기기 도구 호출이 거부됩니다. 허용과 거둠은 다시 시작하거나 연결하지 않아도 다음 호출부터 적용되고, 거부 응답은 어느 스위치가 꺼져 있고 어디서 켜야 하는지를 에이전트에게 알려 주며, 허용을 거두면 그 Operation이 잡고 있던 기기 세션도 놓습니다.

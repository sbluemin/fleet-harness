---
branch: console-use-ai-native-2
---

### fleet-console
#### Changed
- Console use now shows what an agent is doing on your Console: the Operation, group, Theater, or Repository/File panel it reads or changes is briefly wrapped in a pulse that matches the Console use badge, messages and answers it sends carry its name, and groups and Operations it creates are attributed to it.
  ko: 이제 에이전트가 Console 을 쓰는 것이 화면에 보입니다. 에이전트가 읽거나 바꾸는 Operation·그룹·Theater·저장소/파일 패널이 「콘솔 사용」 배지와 같은 펄스로 잠깐 감싸이고, 보낸 메시지와 답에는 에이전트 이름이 붙으며, 만든 그룹과 시작한 Operation 에는 누가 했는지가 남습니다.
- Console use tools are reorganized around the Console's own places (sidebar, Operation panel, Session Analyst, Quick Launch, Repository and File Explorer) and reduced to ten: `console_context`, `console_operations`, `console_organize`, `console_operation`, `console_send`, `console_panel`, `console_analyst`, `console_launch`, `console_repo`, `console_file`. Agents can now start an Operation directly into a group with a title, rename groups, and delete empty ones.
  ko: Console use 도구가 Console 의 자리(사이드바·Operation 패널·Session Analyst·Quick Launch·저장소·파일 탐색기)에 맞춰 10종으로 재편되었습니다: `console_context`, `console_operations`, `console_organize`, `console_operation`, `console_send`, `console_panel`, `console_analyst`, `console_launch`, `console_repo`, `console_file`. 에이전트가 그룹 안에 이름을 붙여 Operation 을 바로 시작하고, 그룹 이름을 바꾸거나 빈 그룹을 지울 수 있습니다.
- Questions an agent asks a Session Analyst through Console use now appear in that Operation's own Analyst panel with the agent's name, and the conversation is there when you open the panel later.
  ko: 에이전트가 Console use 로 Session Analyst 에게 물은 질문이 그 Operation 의 분석가 패널에 에이전트 이름과 함께 나타나고, 나중에 패널을 열어도 대화가 남아 있습니다.
- When an agent closes an Operation, the same undo banner you get for your own closes appears and says which agent closed it.
  ko: 에이전트가 Operation 을 닫으면 직접 닫았을 때와 같은 실행 취소 배너가 뜨고 어느 에이전트가 닫았는지 알려 줍니다.
#### Fixed
- Groups created, renamed, recolored, or deleted by an agent or by another window now appear immediately in the sidebar instead of after a reload.
  ko: 에이전트나 다른 창이 만들거나 이름·색을 바꾸거나 지운 그룹이 새로고침 없이 사이드바에 바로 반영됩니다.
#### Removed
- The Console use automation tool (`console_automation`) is removed, along with the separate event, receipt, session-end, and Theater-list tools. Previously scheduled automations stay paused.
  ko: Console use 의 자동화 도구(`console_automation`)와 별도의 사건·영수증·세션 종료·Theater 목록 도구가 제거되었습니다. 이전에 만든 자동화는 일시정지 상태로 남습니다.

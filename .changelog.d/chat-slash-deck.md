---
branch: chat-slash-deck
---

### fleet-console
#### Added
- Chat Mode composer opens a capability deck: `/` lists the session's commands and skills, `@` lists its subagents, each row carrying the description and argument hint the session itself reports. Category headers stay pinned while the list scrolls, arrow keys move across categories, and a command that takes no arguments sends on selection while one that takes arguments is inserted for you to finish.
  ko: Chat Mode 컴포저에 능력 덱이 열립니다. `/`는 이 세션의 명령과 스킬을, `@`는 서브에이전트를 세우며 각 행이 세션이 스스로 알려 준 설명과 인자 힌트를 함께 답니다. 카테고리 머리글은 목록을 스크롤해도 상단에 붙어 있고, 방향키는 카테고리를 넘나들며 이동하며, 인자가 없는 명령은 고르는 즉시 전송되고 인자를 받는 명령은 이어서 쓰도록 삽입됩니다.
- Local slash-command output such as `/usage` now appears in the chat transcript instead of being dropped.
  ko: `/usage`처럼 로컬에서 실행되는 슬래시 명령의 출력이 사라지지 않고 채팅 기록에 나타납니다.

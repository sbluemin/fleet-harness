---
branch: chat-slash-deck
---

### fleet-console

#### Added
- Chat Mode composer opens a capability deck: `/` lists the session's commands and skills, `@` lists its subagents, each row carrying the description and argument hint the session itself reports. Category headers stay pinned while the list scrolls, arrow keys move across categories, and choosing a row completes your input rather than sending it. A name you have finished typing is highlighted once it matches something the session can actually run.
  ko: Chat Mode 컴포저에 능력 덱이 열립니다. `/`는 이 세션의 명령과 스킬을, `@`는 서브에이전트를 세우며 각 행이 세션이 스스로 알려 준 설명과 인자 힌트를 함께 답니다. 카테고리 머리글은 목록을 스크롤해도 상단에 붙어 있고, 방향키는 카테고리를 넘나들며 이동하며, 행을 고르면 전송이 아니라 입력이 완성됩니다. 다 친 이름은 이 세션이 실제로 부를 수 있는 것과 일치할 때 강조됩니다.
- Commands the Console owns are answered by the Console instead of the agent. `/rename` renames the Operation itself, so the canvas title and sidebar follow; `/context` opens the context meter that already reads the same numbers; `/model` and `/effort` report the coordinate this Operation opened with. The deck marks these rows before you choose one.
  ko: Console이 소유한 명령은 에이전트가 아니라 Console이 답합니다. `/rename`은 Operation 자체의 이름을 바꿔 캔버스 제목과 사이드바가 함께 따라오고, `/context`는 같은 수를 이미 읽고 있는 문맥 계기를 열며, `/model`과 `/effort`는 이 Operation이 열릴 때 정해진 좌표를 알려 줍니다. 덱은 고르기 전에 그 행들을 표시합니다.
- `/clear` asks once before it runs, and the transcript draws a seam where the agent's memory was cut, so the conversation above it is no longer read as context.
  ko: `/clear`는 실행 전에 한 번 확인을 받고, 에이전트의 기억이 끊긴 자리에 기록이 이음매를 긋습니다. 그 위쪽 대화는 더 이상 문맥으로 읽히지 않습니다.

#### Changed
- The deck no longer lists commands that cannot work in a Console chat. Seven were dropped, including one that sets a colour for a prompt bar the Console does not have, one the agent itself refuses outside the terminal, and one that only exists to announce its own removal.
  ko: Console 채팅에서 동작할 수 없는 명령은 덱에 서지 않습니다. 터미널 밖에서는 에이전트 자신이 거절하는 것, Console에 없는 프롬프트 바의 색을 정하는 것, 폐기됐다고 답하려고만 존재하는 것을 포함해 7개가 빠졌습니다.
- Output from a command the agent runs locally is no longer drawn as its answer. It reads as a system line naming the command, so a reply from the model and the result of a command are told apart at a glance.
  ko: 에이전트가 로컬에서 실행한 명령의 출력이 더 이상 답변으로 그려지지 않습니다. 명령 이름을 단 시스템 줄로 읽히므로 모델의 답과 명령의 결과가 한눈에 갈립니다.
- Typing a full command name now puts that command first in the deck. Previously another row whose description happened to mention the same word could sit above it.
  ko: 명령 이름을 끝까지 치면 그 명령이 덱의 첫 행에 섭니다. 이전에는 설명에 같은 단어가 들어간 다른 행이 그 위에 설 수 있었습니다.

#### Fixed
- Skills bundled with the agent, such as `/doctor` and `/batch`, were listed under Commands until the session had run a turn. They now appear under Skills from the first `/`.
  ko: `/doctor`, `/batch`처럼 에이전트에 번들된 스킬이 세션이 한 턴을 돌기 전까지 명령 칸에 서 있었습니다. 이제 첫 `/`부터 스킬 칸에 섭니다.
- Reloading skills mid-session left the deck showing the old list until the session was reopened.
  ko: 세션 도중에 스킬을 다시 읽어도 세션을 다시 열기 전까지 덱이 옛 목록을 세우고 있었습니다.

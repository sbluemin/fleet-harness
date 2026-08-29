---
branch: chat-slash-deck
---

### fleet-console

#### Added
- Chat Mode composer opens a capability deck: `/` lists the session's commands and skills, `@` lists its subagents, each row carrying the description and argument hint the session itself reports. Category headers stay pinned while the list scrolls, arrow keys move across categories, and choosing a row completes your input rather than sending it. A name you have finished typing is highlighted once it matches something the session can actually run.
  ko: Chat Mode 컴포저에 능력 덱이 열립니다. `/`는 이 세션의 명령과 스킬을, `@`는 서브에이전트를 세우며 각 행이 세션이 스스로 알려 준 설명과 인자 힌트를 함께 답니다. 카테고리 머리글은 목록을 스크롤해도 상단에 붙어 있고, 방향키는 카테고리를 넘나들며 이동하며, 행을 고르면 전송이 아니라 입력이 완성됩니다. 다 친 이름은 이 세션이 실제로 부를 수 있는 것과 일치할 때 강조됩니다.
- The deck stands up four commands, chosen because this surface can carry them end to end: `/clear`, `/compact`, `/context`, and `/reload-skills`. Everything else the agent advertises is built for a terminal that has a prompt bar, a model picker, and a session title this surface does not.
  ko: 덱은 명령 네 개를 세웁니다. 이 표면이 끝까지 책임질 수 있는 것으로 골랐습니다 - `/clear`, `/compact`, `/context`, `/reload-skills`. 나머지는 프롬프트 바와 모델 피커와 세션 제목을 가진 터미널을 위해 만들어진 것들이고, 여기에는 그 중 어느 것도 없습니다.
- A command runs as its own line in the transcript instead of as a conversation turn. There is no thinking node, no elapsed clock, and no streaming text, because two of these never reach the model at all. `/compact` carries a gauge: it sweeps while the agent is compacting, because the agent reports no progress figure, and then fills to the share of context actually reclaimed, with the before and after in the numbers the agent itself measured.
  ko: 명령은 대화 턴이 아니라 기록 안의 자기 줄로 실행됩니다. 사고 노드도 경과 시계도 흐르는 글도 없습니다 - 이 중 둘은 모델에 닿지도 않기 때문입니다. `/compact`에는 계기가 붙습니다. 압축하는 동안에는 왕복하고(에이전트가 진척을 알려 주지 않습니다) 끝나면 실제로 되찾은 문맥의 비율만큼 채워지며, 앞뒤 크기는 에이전트가 잰 수 그대로입니다.
- `/clear` asks once, then empties the chat view along with the agent's memory. A conversation the agent cannot read is not a record you can trust, so both sides forget the same thing.
  ko: `/clear`는 한 번 확인한 뒤 에이전트의 기억과 함께 채팅 화면도 비웁니다. 에이전트가 읽지 못하는 대화는 믿을 수 있는 기록이 아니므로, 양쪽이 같은 것을 잊습니다.
- `/context` opens the context meter that already reads the same numbers, instead of asking the agent to print them.
  ko: `/context`는 에이전트에게 다시 인쇄시키는 대신, 같은 수를 이미 읽고 있는 문맥 계기를 엽니다.

#### Changed
- Typing a full command name now puts that command first in the deck. Previously another row whose description happened to mention the same word could sit above it.
  ko: 명령 이름을 끝까지 치면 그 명령이 덱의 첫 행에 섭니다. 이전에는 설명에 같은 단어가 들어간 다른 행이 그 위에 설 수 있었습니다.

#### Fixed
- Skills bundled with the agent, such as `/doctor` and `/batch`, were listed under Commands until the session had run a turn. They now appear under Skills from the first `/`.
  ko: `/doctor`, `/batch`처럼 에이전트에 번들된 스킬이 세션이 한 턴을 돌기 전까지 명령 칸에 서 있었습니다. 이제 첫 `/`부터 스킬 칸에 섭니다.
- Reloading skills mid-session left the deck showing the old list until the session was reopened.
  ko: 세션 도중에 스킬을 다시 읽어도 세션을 다시 열기 전까지 덱이 옛 목록을 세우고 있었습니다.

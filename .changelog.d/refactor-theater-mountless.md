---
branch: refactor/theater-mountless
---

### fleet-console
#### Changed
- Every registered Theater works without mounting it first: open its conversations and manage its groups directly, and the right-side tools follow the Theater of the conversation you are viewing.
  ko: Theater를 먼저 마운트하지 않아도 등록된 모든 Theater에서 바로 대화를 열고 그룹을 관리할 수 있으며, 오른쪽 도구는 보고 있는 대화의 Theater를 따라갑니다.
- Codex, Files, Repository, Shell and Skills now sit in one tool bar above every conversation, including Commodore and Commander chats, and open for that conversation's Theater.
  ko: Codex, 파일, 저장소, Shell, 스킬이 사령관·지휘관 채팅을 포함한 모든 대화 위의 도구모음 하나에 모여, 그 대화의 Theater로 열립니다.
- Shell is a single Console-wide terminal that opens even without a Theater and starts in the root of the Theater you last viewed.
  ko: Shell은 Console 전체에서 하나이며, Theater가 없어도 열리고 마지막으로 본 Theater의 루트에서 시작합니다.
- The globe above Commander and Commodore chats lets you choose Fleet Browser or Session Browser, the new name for Operation Browser; the separate Fleet Browser entry is gone and Shift+Cmd+B still toggles it.
  ko: 지휘관·사령관 채팅 위의 지구본에서 Fleet 브라우저와 Session 브라우저(Operation 브라우저의 새 이름)를 고를 수 있으며, 별도의 Fleet 브라우저 진입점은 사라졌고 Shift+Cmd+B로는 계속 여닫을 수 있습니다.
- Commodore chats no longer show the CLI/chat view switch.
  ko: 사령관 채팅에는 더 이상 CLI/채팅 보기 전환이 보이지 않습니다.
#### Added
- In Fleet Desktop, the Commodore can browse in its own Session Browser, kept separate from your Fleet Browser tabs.
  ko: Fleet Desktop에서 사령관이 사람의 Fleet 브라우저 탭과 분리된 자신의 Session 브라우저를 사용할 수 있습니다.

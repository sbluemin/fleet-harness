---
branch: surface-structure
---

### fleet-console
#### Added
- Open files, read the wiki and use the Shell from a Tools tab in Console's mobile layout; Files switches between the tree and the document on narrow screens.
  ko: Console 모바일 레이아웃의 도구 탭에서 파일과 위키를 열고 Shell을 사용할 수 있으며, 좁은 화면의 Files는 트리와 문서를 번갈아 보여 줍니다.
- Review wiki conflicts with the base, current version and proposal side by side, then reject, resolve or re-propose; outdated Cowork drafts can be reapplied to the latest version or discarded, and overlapping changes keep the original draft.
  ko: 위키 충돌의 기준본·현재본·제안을 나란히 비교한 뒤 반려·해결·재제안할 수 있고, 기준이 낡은 Cowork 초안은 최신본에 다시 맞추거나 버릴 수 있으며 변경이 겹치면 원래 초안을 보존합니다.
- Approve or reject several wiki proposals at once, with outdated proposals left out, and move through the wiki list and tag filters with the keyboard.
  ko: 기준이 낡은 제안은 제외한 채 위키 제안을 여러 개 한꺼번에 승인하거나 반려하고, 키보드로 위키 목록과 태그 필터를 이동할 수 있습니다.
- Browse large files safely, jump to the end or a chosen range of a log, and see list and search limits as counts.
  ko: 큰 파일을 안전하게 읽고 로그의 끝이나 원하는 범위로 이동하며, 목록과 검색의 상한을 개수로 확인할 수 있습니다.
- Files opens single-clicked files in a reusable preview tab, keeps double-clicked or pinned tabs, and points legacy wiki copies left in the repository to their wiki entries.
  ko: Files는 한 번 클릭한 파일을 다시 쓰는 미리보기 탭으로 열고 더블클릭하거나 고정한 탭은 유지하며, 저장소에 남은 옛 위키 사본에서 해당 위키 항목으로 안내합니다.

#### Changed
- The Shell marks where a restarted session begins, dims the earlier output and locks input while the connection is down; Ctrl-C stops a flood of output almost immediately.
  ko: Shell은 재시작된 세션이 시작되는 지점을 표시하고 이전 출력을 흐리게 하며 연결이 끊긴 동안 입력을 잠그고, Ctrl+C로 쏟아지는 출력을 거의 즉시 멈춥니다.
- Files and the wiki tell you when an open document changes or is deleted on disk instead of replacing it silently, and the wiki says when a restart ended an in-progress Cowork draft.
  ko: Files와 위키는 열린 문서가 디스크에서 바뀌거나 지워지면 조용히 바꾸지 않고 알려 주며, 위키는 재시작으로 진행 중이던 Cowork 초안이 끝났을 때 알려 줍니다.

#### Fixed
- Reloading or reconnecting no longer prints Shell output twice, and Escape no longer closes the Shell from outside it.
  ko: 새로고침하거나 다시 연결해도 Shell 출력이 두 번 찍히지 않고, Shell 밖에서 누른 Esc로 Shell이 닫히지 않습니다.
- Touchscreen terminals start at your configured font size instead of shrinking the text.
  ko: 터치 기기에서도 터미널 글꼴을 작게 줄이지 않고 설정한 크기로 시작합니다.

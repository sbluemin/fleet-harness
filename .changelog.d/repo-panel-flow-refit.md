---
branch: repo-panel-flow-refit
---

### fleet-console
#### Changed
- The Repository panel now folds the commit inspector into a one-line peek chip when you switch to the Changes view, so staging gets its full height back and one click returns you to the commit you were reading.
  ko: 저장소 패널에서 변경 뷰로 전환하면 커밋 인스펙터가 한 줄 칩으로 접힙니다. 스테이징이 전체 높이를 되찾고, 칩 한 번으로 보던 커밋으로 돌아갑니다.
- Opening a stash now shows a dedicated card with the stashed files - untracked ones included - and Apply, Apply-and-remove, and Delete right on the card, and the Stash button asks for an optional message before saving.
  ko: 스태시를 열면 치워 둔 파일(untracked 포함)과 적용·적용 후 제거·삭제 버튼이 붙은 전용 카드가 열립니다. Stash 버튼은 저장 전에 메시지를 한 번 묻습니다.
- The staging file list gained the same list/tree toggle as the commit inspector, and row actions now spell out Stage, Unstage, Discard, or Delete on hover instead of showing bare glyphs.
  ko: 스테이징 파일 목록에 커밋 인스펙터와 같은 목록/트리 토글이 생겼고, 행 액션은 글리프 대신 호버 시 스테이지·내리기·버리기·삭제 라벨을 보여 줍니다.
#### Fixed
- Stashing or pulling from the toolbar now refreshes the staging list immediately, so the list no longer disagrees with the sidebar counts until a manual reload.
  ko: 툴바에서 스태시·Pull을 실행하면 스테이징 목록이 즉시 갱신됩니다. 수동 새로고침 전까지 카운트와 목록이 어긋나던 문제가 사라집니다.

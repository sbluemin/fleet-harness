---
branch: repo-panel-workbench
---

### fleet-console

#### Added
- The Repository panel now works like a Git client, not just a viewer: a Local Changes view splits unstaged and staged files with per-file and bulk stage, unstage, and two-step discard, and a commit box with amend support writes commits from the staged set.
  ko: 저장소 패널이 뷰어를 넘어 Git 클라이언트처럼 동작합니다. Local Changes 뷰가 미스테이지/스테이지 파일을 나눠 개별·일괄 스테이지, 해제, 2단계 버리기를 제공하고, amend를 지원하는 커밋 상자가 스테이지된 파일로 커밋을 만듭니다.
- Pull, Push, and Stash join Sync on the Repository panel toolbar, with ahead/behind counts on the current branch; pull stays fast-forward-only and diverged histories are handed back with a clear message instead of a server-side merge.
  ko: 저장소 패널 툴바에 Sync와 나란히 Pull, Push, Stash가 생기고 현재 브랜치의 ahead/behind 수가 표시됩니다. pull은 fast-forward만 수행하며, 갈라진 히스토리는 서버가 병합하지 않고 명확한 안내로 돌려줍니다.
- Checkout tabs above the Repository workspace switch between the root checkout and its worktrees in one click, and the commit inspector gains a File Tree tab that browses the full tree at that commit folder by folder.
  ko: 저장소 워크스페이스 상단의 체크아웃 탭으로 루트 체크아웃과 워크트리를 한 번에 오갑니다. 커밋 검사기에는 File Tree 탭이 생겨 그 커밋 시점의 전체 트리를 폴더 단위로 탐색합니다.
- Write actions guard themselves before running: the panel locks its write verbs while the index is locked or a merge, rebase, or cherry-pick is in progress, and warns when Operations are stationed in the same checkout.
  ko: 쓰기 동작이 실행 전에 스스로 울타리를 칩니다. 인덱스가 잠겨 있거나 merge/rebase/cherry-pick이 진행 중이면 쓰기 동사를 잠그고, 같은 체크아웃에 Operation이 주둔 중이면 경고합니다.

#### Changed
- The WORKING > Changes view is now the staging workbench: the previous unified changed-file list (with its filter and tree grouping) is replaced by the unstaged/staged split.
  ko: 작업 > 변경 뷰가 스테이징 워크벤치로 바뀝니다. 기존의 통합 변경 파일 목록(필터·트리 묶음 포함)은 미스테이지/스테이지 분할로 대체됩니다.
- The Repository workspace filter now walks the whole sidebar - branches, tags, stashes, and worktrees answer the same query as repositories.
  ko: 저장소 워크스페이스 필터가 사이드바 전체를 거릅니다. 브랜치·태그·스태시·워크트리가 저장소와 같은 질의에 응답합니다.
- Stash rows offer apply, pop, and drop from their context menu, with drop behind the product's two-step arm.
  ko: 스태시 행의 컨텍스트 메뉴에서 적용·적용 후 제거·삭제를 실행할 수 있고, 삭제는 제품 공용 2단계 무장 뒤에 있습니다.

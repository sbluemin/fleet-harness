---
branch: repository-refit
---

### fleet-console
#### Changed
- Repository panel refit: the top context band is gone; the repository/worktree switcher now leads the sidebar tree, and Fetch/Pull/Push/Stash share one work bar with the History/Changes segmented tabs and the history filter, collapsing from labels to icons to a More menu as the panel narrows.
  ko: Repository 패널 개편: 상단 컨텍스트 띠를 없애고 저장소·워크트리 전환기를 사이드바 트리 첫 행으로 옮겼으며, Fetch/Pull/Push/Stash가 기록/변경 세그먼트 탭·기록 필터와 한 작업 줄을 공유하고 패널이 좁아지면 라벨 → 아이콘 → 더 보기 메뉴로 접힙니다.
- Repository tree now lists Worktrees, Branches, Remotes (grouped by remote with a host mark), Tags, and Stashes as sibling sections; the current branch shows a check mark, and branches with an upstream show ahead/behind counts.
  ko: Repository 트리가 워크트리·브랜치·원격(원격 이름으로 묶고 호스트 마크 표시)·태그·스태시를 같은 단계의 섹션으로 보여 주며, 현재 브랜치는 체크 표시로, 업스트림이 있는 브랜치는 ahead/behind 수로 표시됩니다.
- Repository controls use one glyph set and three control tiers (verb chips, quiet icon buttons, segmented tabs); unicode arrow/cross glyphs, the underline tabs, and the always-on bottom status bar are replaced (results now appear as a transient toast).
  ko: Repository 컨트롤이 한 벌의 글리프와 세 층(동사 칩·조용한 아이콘 버튼·세그먼트 탭)만 사용하며, 유니코드 화살표·✕ 글리프, 밑줄 탭, 상시 하단 상태바를 대체했습니다(결과는 잠시 뜨는 토스트로 표시).
- Changed-file lists in the Changes view and the commit inspector are single-line rows with the directory dimmed and the file name kept visible when the path is cut.
  ko: 변경 뷰와 커밋 검사기의 변경 파일 목록이 한 줄 행으로 바뀌었고, 경로가 잘려도 디렉터리는 흐리게·파일명은 보이도록 표시합니다.
- The commit inspector's File Tree tab uses the File Explorer grammar (folder/file icons, guides, change badges) and opens the selected file: a diff for files changed in that commit, otherwise the file content at that commit.
  ko: 커밋 검사기의 파일 트리 탭이 파일 탐색기 문법(폴더·파일 아이콘, 가이드 선, 변경 배지)을 쓰고 선택한 파일을 엽니다. 그 커밋에서 바뀐 파일은 diff로, 나머지는 그 커밋 시점의 내용으로 표시됩니다.
#### Fixed
- Repository picker rows no longer inherit the context bar's branch styling, so repository names and branch labels keep their intended sizes.
  ko: Repository 선택기 행이 컨텍스트 바의 브랜치 스타일을 물려받지 않아 저장소 이름과 브랜치 라벨이 의도한 크기로 표시됩니다.

---
branch: repo-panel-refit-p1
---

### fleet-console
#### Changed
- The repository panel names its remote verb after what it does: the toolbar reads Fetch, its result speaks about origin's commits, and the tooltip drops raw git flags.
  ko: 저장소 패널의 원격 동사가 하는 일을 그대로 말합니다. 툴바는 가져오기로 읽히고, 결과 문면은 origin의 커밋을 기준으로 말하며, 툴팁에서 git 플래그가 사라집니다.
- Destructive verbs say what they destroy: deleting an untracked file is named apart from discarding tracked changes, and dropping a stash asks about deletion instead of a bare "Sure?".
  ko: 파괴적인 동사가 무엇을 없애는지 말합니다. 추적되지 않는 파일 삭제는 추적 파일의 변경 버리기와 이름이 갈리고, 스태시 삭제는 "정말요?" 대신 삭제 여부를 묻습니다.

#### Added
- The source tree carries a reload control that re-reads local repository state, working tree, stashes, refs, and ahead/behind, without contacting the remote.
  ko: 소스 트리에 로컬 저장소 상태(작업 트리·스태시·refs·ahead/behind)를 원격 접속 없이 다시 읽는 새로고침 컨트롤이 생겼습니다.
- Cut-off reads say so: a capped status list, a commit whose read was cut off, and a scan that hit its depth limit each carry a visible mark instead of looking complete.
  ko: 잘린 읽기가 잘렸다고 말합니다. 상한에 걸린 상태 목록, 잘린 커밋 읽기, 탐색 깊이 한도가 각각 표식을 달아 완전한 것처럼 보이지 않습니다.

#### Fixed
- Failed repository reads explain themselves. History, commit, diff, and compare failures now show a sentence and a next step instead of a raw error code.
  ko: 저장소 읽기 실패가 스스로를 설명합니다. 기록·커밋·디프·비교 실패가 오류 코드 대신 문장과 다음 행동을 보여줍니다.
- A repository whose state could not be read no longer looks clean: write verbs stay locked and say why, instead of turning on as if there were no merge, rebase, or index lock in progress.
  ko: 상태를 읽지 못한 저장소가 더 이상 깨끗한 저장소처럼 보이지 않습니다. 병합·리베이스·index lock이 없는 것처럼 쓰기 동사가 켜지는 대신 잠긴 채 이유를 말합니다.
- The changes view stays usable in a narrow rail: the file list and diff stack instead of crushing filenames to zero width, the diff header keeps its close button in reach, and the commit button no longer collapses into a column of characters.
  ko: 변경 뷰가 좁은 레일에서도 쓸 수 있습니다. 파일 목록과 디프가 위아래로 쌓여 파일 이름이 0px로 눌리지 않고, 디프 머리의 닫기 버튼이 화면 안에 남으며, 커밋 버튼이 세로 글자기둥으로 무너지지 않습니다.
- Added and deleted diff lines keep their signal colors in every theme instead of drifting toward yellow-green and amber.
  ko: 디프의 추가·삭제 줄이 모든 테마에서 황록·호박으로 밀리지 않고 자기 신호색을 지킵니다.

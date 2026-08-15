---
branch: fexp-signal-honesty
---

### fleet-console
#### Changed
- File Explorer marks every limit it used to hide: a folder listing cut at 500 entries shows a marker row, the file filter reports live scan progress and warns when its folder cap skips matches, palette search flags capped results, and an oversized git status notes hidden badges.
  ko: 파일 탐색기가 숨겨오던 모든 상한을 표시합니다. 500개에서 잘린 폴더 목록은 표식 행을, 파일 필터는 실시간 검색 진행과 상한으로 누락된 매치 경고를, 팔레트 검색은 상한 표식을 보여주고, 상한을 넘긴 git 상태는 생략된 배지를 알립니다.
- Version-control internals (.git, .svn, .hg) no longer appear in File Explorer listings, filters, or searches; with hidden files shown, a named muted row records what was withheld.
  ko: 버전 관리 날것(.git, .svn, .hg)이 파일 탐색기의 목록·필터·검색에 더 이상 나타나지 않습니다. 숨김 파일 표시 중에는 무엇이 숨겨졌는지 이름 있는 비활성 행으로 알립니다.

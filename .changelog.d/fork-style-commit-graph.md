---
branch: fork-style-commit-graph
---

### fleet-console
#### Added
- Choose whether Repository history lists commits in topological or date order, defaulting to topological so a branch and its commits stay contiguous.
  ko: 저장소 기록이 커밋을 계보순으로 나열할지 시간순으로 나열할지 고를 수 있습니다. 기본값은 브랜치와 그 커밋이 끊기지 않고 이어지는 계보순입니다.
- Show the author of each commit in Repository history, and mark the commits that carry a message body beyond their subject.
  ko: 저장소 기록에서 각 커밋의 작성자를 보여 주고, 제목 밖에 메시지 본문이 있는 커밋을 표시합니다.

#### Changed
- Draw the Repository commit graph one row at a time, so a row spends width only on the lanes it actually draws and its commit text sits beside the graph rather than behind every lane the list ever opens. Branch and merge connectors follow right angles with rounded corners instead of diagonals.
  ko: 저장소 커밋 그래프를 행 단위로 그립니다. 각 행은 실제로 그리는 레인만큼만 폭을 쓰고, 커밋 본문이 목록 전체가 여는 모든 레인 뒤가 아니라 그래프 바로 옆에 붙습니다. 분기와 병합 연결선은 대각선 대신 모서리가 둥근 직각을 따릅니다.
- Restyle branch, tag, and remote badges as bold labels with their own icon segment, tinted by the graph lane of the commit they sit on while the current checkout stays on the location tone. Each commit subject now raises its Conventional Commit prefix above the rest of the line.
  ko: 브랜치·태그·원격 뱃지를 아이콘 칸이 따로 있는 볼드 라벨로 다시 그립니다. 색조는 그 커밋이 놓인 그래프 레인을 따르고, 현재 체크아웃은 위치 색조를 유지합니다. 커밋 제목은 Conventional Commit 접두를 나머지 줄보다 강조합니다.

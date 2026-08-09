---
branch: fork-style-commit-graph
---

### fleet-console
#### Added
- Repository history now shows the author of each commit, marks the commits that carry a message body beyond their subject, and lets you choose whether commits are listed in topological or date order. The default is topological, so a branch and its commits stay contiguous.
  ko: 저장소 기록이 각 커밋의 작성자를 보여 주고, 제목 밖에 메시지 본문이 있는 커밋을 표시하며, 커밋을 계보순으로 나열할지 시간순으로 나열할지 고를 수 있게 합니다. 기본값은 브랜치와 그 커밋이 끊기지 않고 이어지는 계보순입니다.

#### Changed
- Draw the Repository commit graph one row at a time, so a row spends width only on the lanes it actually draws and its commit text sits beside the graph rather than behind every lane the list ever opens. Branch and merge connectors follow right angles with rounded corners instead of diagonals. Branch, tag, and remote badges are bold labels with their own icon segment, tinted by the graph lane of the commit they sit on while the current checkout stays on the location tone, and each commit subject raises its Conventional Commit prefix above the rest of the line.
  ko: 저장소 커밋 그래프를 행 단위로 그립니다. 각 행은 실제로 그리는 레인만큼만 폭을 쓰고, 커밋 본문이 목록 전체가 여는 모든 레인 뒤가 아니라 그래프 바로 옆에 붙습니다. 분기와 병합 연결선은 대각선 대신 모서리가 둥근 직각을 따릅니다. 브랜치·태그·원격 뱃지는 아이콘 칸이 따로 있는 볼드 라벨이 되어 그 커밋이 놓인 그래프 레인의 색조를 따르고 현재 체크아웃은 위치 색조를 유지하며, 커밋 제목은 Conventional Commit 접두를 나머지 줄보다 강조합니다.

#### Fixed
- Reach the rest of Repository history in repositories whose commit messages are large enough to fill the log read buffer. Such a page previously reported that the first commit had been reached, and the commit the read stopped inside was listed with missing details and then skipped by the next page.
  ko: 커밋 메시지가 커서 로그 읽기 버퍼를 채우는 저장소에서도 나머지 기록에 닿을 수 있습니다. 이전에는 그런 페이지가 첫 커밋에 도달했다고 알렸고, 읽기가 중간에서 멈춘 커밋은 세부 정보가 빠진 채 목록에 오른 뒤 다음 페이지에서 건너뛰어졌습니다.

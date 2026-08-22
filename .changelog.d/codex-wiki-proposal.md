---
branch: codex-wiki-proposal
---

### fleet-console
#### Added
- Codex now shows what a pending patch actually changes: the approval screen renders a line diff against the live entry, states the version step, and keeps Approve and Reject pinned to the top of the pane.
  ko: Codex가 대기 중인 패치의 실제 변경 내용을 보여줍니다. 승인 화면이 살아 있는 항목과의 라인 diff를 그리고, 버전 변화를 명시하며, 승인·반려 버튼을 판 상단에 고정합니다.
- Patches staged together from one source are grouped in the review queue and can be approved in a single action.
  ko: 한 소스에서 함께 stage된 패치를 검토 대기열에서 한 묶음으로 보여주고, 한 번의 조작으로 모두 승인할 수 있습니다.
- Conflicts can now be resolved in Codex. The conflict screen is titled with the entry in conflict, explains why it happened, diffs current against proposed, and offers Keep current, Take proposed, or Resolve manually.
  ko: 이제 Codex에서 충돌을 해결할 수 있습니다. 충돌 화면이 충돌한 항목을 제목으로 삼고, 발생 이유를 설명하며, 현재와 제안을 diff로 비교하고, 현재 유지·제안 수용·직접 해결을 제공합니다.

#### Changed
- Codex document typography now follows the width of the reading pane instead of the browser window, so a split reader no longer renders a page-sized title. A wiki entry opened in the rail reaches its body in less than half the vertical space it used to take.
  ko: Codex 문서 타이포그래피가 브라우저 창이 아니라 읽기 판의 폭을 따릅니다. 분할 리더가 더 이상 전체 페이지 크기의 제목을 그리지 않으며, 레일에서 연 위키 항목이 본문에 닿기까지 쓰던 세로 공간이 절반 이하로 줄었습니다.
- Codex additions and removals now read as state colors across the review queue, conflict resolution, and Cowork draft review, so the three surfaces describe a change the same way.
  ko: Codex의 추가·삭제 표현이 검토 대기열·충돌 해결·Cowork 초안 검토에서 모두 상태색으로 통일되어, 세 화면이 같은 변경을 같은 방식으로 말합니다.
- The review queue lists who proposed each patch, so a queue can be triaged without opening every entry.
  ko: 검토 대기열이 각 패치의 제안자를 함께 보여주어, 항목을 하나씩 열지 않고도 분류할 수 있습니다.

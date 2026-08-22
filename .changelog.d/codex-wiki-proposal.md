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
- Codex entries can now be edited in place. Every entry has an Edit action that opens a plain Markdown editor and saves as an approved patch, so writing to the wiki no longer requires prompting a model.
  ko: 이제 Codex 항목을 그 자리에서 편집할 수 있습니다. 모든 항목에 편집 버튼이 생겨 평범한 마크다운 편집기를 열고 승인된 패치로 저장하므로, 위키에 쓰기 위해 모델에게 부탁할 필요가 없습니다.
- Codex shows which entries reference the one you are reading. Authored `[[wiki:]]` links now appear as a Referenced by section above tag similarity, and inline links read as entry titles instead of slugs.
  ko: Codex가 지금 보는 항목을 참조하는 다른 항목을 보여줍니다. 작성자가 그은 `[[wiki:]]` 링크가 태그 유사도 위의 별도 섹션으로 올라오고, 본문 링크가 슬러그가 아니라 항목 제목으로 읽힙니다.
- The Codex index can be filtered by entry type and status, using values Fleet Wiki already defines.
  ko: Codex 색인을 항목 종류와 상태로 좁힐 수 있습니다. Fleet Wiki가 이미 정의해 둔 값을 그대로 씁니다.
- Codex can run a wiki health check on demand instead of only replaying whatever an agent last logged.
  ko: 에이전트가 마지막으로 남긴 로그를 재생하는 대신, Codex에서 위키 검사를 직접 실행할 수 있습니다.
- Codex can be asked a question. The new Ask tab searches the corpus and answers with the entries that carry the answer, the claims they make, and the raw sources behind those claims - it cites rather than composes, so nothing appears without a source.
  ko: Codex에 질문할 수 있습니다. 새 '말뭉치에 묻기' 탭이 말뭉치를 찾아 답을 담은 항목과 그 항목이 내세우는 근거, 근거의 원본 소스를 함께 보여줍니다. 문장을 지어내지 않고 인용하므로 출처 없는 내용이 나타나지 않습니다.

#### Changed
- Codex document typography now follows the width of the reading pane instead of the browser window, so a split reader no longer renders a page-sized title. A wiki entry opened in the rail reaches its body in less than half the vertical space it used to take.
  ko: Codex 문서 타이포그래피가 브라우저 창이 아니라 읽기 판의 폭을 따릅니다. 분할 리더가 더 이상 전체 페이지 크기의 제목을 그리지 않으며, 레일에서 연 위키 항목이 본문에 닿기까지 쓰던 세로 공간이 절반 이하로 줄었습니다.
- Codex additions and removals now read as state colors across the review queue, conflict resolution, and Cowork draft review, so the three surfaces describe a change the same way.
  ko: Codex의 추가·삭제 표현이 검토 대기열·충돌 해결·Cowork 초안 검토에서 모두 상태색으로 통일되어, 세 화면이 같은 변경을 같은 방식으로 말합니다.
- The review queue lists who proposed each patch, so a queue can be triaged without opening every entry.
  ko: 검토 대기열이 각 패치의 제안자를 함께 보여주어, 항목을 하나씩 열지 않고도 분류할 수 있습니다.

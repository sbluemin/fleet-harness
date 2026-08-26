---
branch: codex-expanded-refit
---

### fleet-console
#### Added
- Codex reading at full size now keeps a head bar that names the document you are reading, shows how far into it you are, and carries Find, Copy link, Source and reading width beside the close button. Cmd+K opens an entry switcher inside the reading surface, so you can search the catalog and move to the next document without leaving full size, and a tag in the document opens that same switcher already filtered.
  ko: Codex를 크게 읽을 때 머리줄이 읽고 있는 문서의 이름과 어디까지 읽었는지를 말하고, 닫기 옆에 찾기·링크 복사·원문·읽기 폭이 함께 섭니다. Cmd+K는 읽는 화면 안에서 항목 전환기를 열어 크게 보기를 벗어나지 않고 카탈로그를 검색해 다음 문서로 넘어가게 하고, 본문의 태그를 누르면 그 태그로 걸러진 같은 전환기가 열립니다.
- The document you are reading now lives in the address bar, so a reload comes back to the same document at the same place and in the same view, the browser's back and forward walk the documents you moved through, and Copy link hands someone else exactly what you are looking at.
  ko: 읽고 있는 문서가 주소에 실립니다. 새로고침해도 같은 문서의 같은 자리, 같은 화면으로 돌아오고, 브라우저의 뒤로·앞으로가 지나온 문서를 그대로 오가며, 링크 복사는 지금 보고 있는 것을 그대로 건넬 수 있게 합니다.
- Full-size reading is now keyboard-first: the document body takes focus when it opens, so Space, PageDown, Home and End move through it, J and K jump between sections, Cmd+[ and Cmd+] walk reader history, and Cmd+F finds inside the document instead of across the whole page.
  ko: 크게 읽기가 키보드로 시작합니다. 열리는 순간 본문이 초점을 받아 Space·PageDown·Home·End로 읽어 내려가고, J·K로 섹션을 건너뛰고, Cmd+[·Cmd+]로 읽던 문서를 오가며, Cmd+F는 페이지 전체가 아니라 이 문서 안에서 찾습니다.
- Reading width and size can be set to narrow, wide or large, the full markdown source can be read and copied, and on a wide screen related entries and backlinks move beside the text instead of waiting at the end of it.
  ko: 읽기 폭과 크기를 좁게·넓게·크게 중에서 고를 수 있고, 마크다운 원문을 그대로 보고 복사할 수 있으며, 넓은 화면에서는 관련 항목과 백링크가 문서 끝이 아니라 본문 옆에 섭니다.

#### Fixed
- The table of contents no longer freezes on the first section when you open a document at full size. Moving the reader between the split pane and full size re-anchors the scroll spy, so the current section keeps following what you are reading.
  ko: 문서를 크게 열었을 때 목차가 첫 섹션에 얼어붙지 않습니다. 분할 화면과 크게 보기 사이를 오갈 때 스크롤 추적을 다시 걸어, 현재 섹션이 읽는 자리를 계속 따라옵니다.
- Reader history keeps your place. Following a link out of a long document and pressing back returns to the line you left, instead of dropping you at the top, and a reload restores the same scroll position as well.
  ko: 읽기 기록이 읽던 자리를 지킵니다. 긴 문서에서 링크를 타고 나갔다가 뒤로 돌아오면 맨 위가 아니라 떠난 줄로 돌아오고, 새로고침해도 같은 자리에서 이어집니다.

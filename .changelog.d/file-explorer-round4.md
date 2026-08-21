---
branch: file-explorer-round4
---

### fleet-console
#### Changed
- Find files from the Files panel with one search that skips dependency and build folders, instead of opening folder after folder until it gives up. A file six levels deep now answers in milliseconds, path fragments such as `deep/needle` match, and Escape clears the filter instead of closing the document you were reading.
  ko: 파일 패널의 찾기가 폴더를 하나씩 열어 보다 포기하는 대신, 의존성·빌드 폴더를 건너뛴 한 번의 검색으로 답합니다. 여섯 단계 깊이의 파일도 밀리초 안에 나오고 `deep/needle` 같은 경로 조각도 걸리며, Esc는 읽던 문서를 닫는 대신 필터를 해제합니다.
- Mark an open document that changed on disk and reload it on your click, so an agent editing the file no longer leaves you reading a stale copy without saying so.
  ko: 열어 둔 문서가 디스크에서 바뀌면 표식을 세우고 클릭할 때 다시 읽습니다. 에이전트가 파일을 고쳐도 아무 말 없이 낡은 사본을 읽고 있게 두지 않습니다.
- Show a large file as soon as you open it by drawing only the lines on screen, and say plainly how much of the file the preview holds. Long lines can now be wrapped instead of scrolling sideways for hundreds of screens.
  ko: 큰 파일은 화면에 보이는 줄만 그려 여는 즉시 표시하고, 미리보기가 파일의 어디까지인지 그대로 밝힙니다. 긴 줄은 화면 수백 장을 옆으로 흐르는 대신 줄바꿈할 수 있습니다.
- Roll uncommitted changes up the folders that contain them, so the working set is visible at the root instead of only after expanding to the file.
  ko: 미커밋 변경을 그 파일을 품은 폴더까지 접어 올려, 파일까지 펼쳐야 보이던 작업 세트를 루트에서 바로 알아볼 수 있습니다.
- Size the panel from the window when a document opens, and mark how many open files the strip is hiding, keeping the active one in view.
  ko: 문서를 열 때 패널 폭을 창 크기에서 정하고, 칩 띠가 감춘 열린 파일 수를 표시하며 활성 파일은 항상 보이게 유지합니다.
- Reach the file tree by keyboard the way a tree is expected to work: type-ahead jumps, PageUp/PageDown, and Shift+F10 or the Context Menu key opening the row menu that every row already advertised.
  ko: 파일 트리를 트리답게 키보드로 다룹니다. 이름 첫 글자로 건너뛰기, PageUp/PageDown, 그리고 모든 행이 이미 알리고 있던 행 메뉴를 Shift+F10 또는 ContextMenu 키로 엽니다.

#### Fixed
- Keep every folder you left open actually open after a reload, instead of restoring only the first few and drawing the rest as open but empty.
  ko: 새로고침 뒤에도 열어 두었던 폴더가 실제로 열린 채 복원됩니다. 앞의 일부만 복원하고 나머지를 열린 척 빈 폴더로 그리지 않습니다.
- Cut a long listing at the alphabetical boundary the cap message describes, so the entries it drops are the ones after the limit rather than a scattered sample from the middle.
  ko: 긴 목록을 안내문이 말하는 이름순 경계에서 자릅니다. 생략되는 항목이 가운데에서 흩어져 빠지는 대신 상한 뒤쪽 항목이 됩니다.
- Keep a folder that fails to open expanded with the reason and a retry, instead of silently collapsing it, and say when live updates are limited in this Theater.
  ko: 열기에 실패한 폴더를 조용히 접지 않고 사유와 다시 시도를 단 채 열어 둡니다. 이 Theater에서 실시간 갱신이 제한될 때도 그 사실을 알립니다.

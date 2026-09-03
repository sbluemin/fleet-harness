---
branch: file-explorer-quiet
---

### fleet-console
#### Added
- Press Space on a file in the Files tree to peek at its first lines, image, or size in a card beside the row without opening a document; Enter opens it, Escape or Space closes it, and the arrow keys move the peek to the next file.
  ko: 파일 트리에서 파일에 Space를 누르면 문서를 열지 않고 행 옆 카드에서 첫 줄·이미지·크기를 훑어볼 수 있습니다. Enter는 열기, Escape나 Space는 닫기, 방향키는 다음 파일로 훑기를 옮깁니다.
- Open ancestor folders stay pinned at the top of the Files tree while you scroll deep into them, and clicking a pinned folder jumps back to it.
  ko: 깊은 폴더를 스크롤하는 동안 열린 조상 폴더가 파일 트리 상단에 고정되어 남고, 고정된 폴더를 누르면 그 행으로 돌아갑니다.
- Hovering a Files tree row reveals peek, copy relative path, and reveal-in-file-manager actions, with an in-place "Copied" note instead of a toast.
  ko: 파일 트리 행에 마우스를 올리면 훑어보기·상대 경로 복사·파일 관리자에서 보기 동작이 나타나고, 복사 확인은 토스트 대신 그 자리에서 표시됩니다.
- Path segments in the document header open the folder's file list for direct navigation, and a header copy button copies the relative path (Alt+click for the absolute path) with an in-place confirmation.
  ko: 문서 헤더의 경로 조각을 누르면 그 폴더의 파일 목록이 열려 바로 이동할 수 있고, 헤더의 복사 버튼이 상대 경로(Alt+클릭은 절대 경로)를 복사하며 확인은 제자리에 표시됩니다.
#### Changed
- The Files tree header rests as a single borderless filter line: the Files/Contents scope appears inside the field while typing, sort, hidden files, and refresh moved into one menu, and search status collapses to one line.
  ko: 파일 트리 헤더가 테두리 없는 필터 한 줄로 쉬며, 입력 중에만 파일/내용 범위가 필드 안에 나타나고 정렬·숨김 파일·새로고침은 메뉴 하나로 옮겨졌으며 검색 상태는 한 줄로 합쳐졌습니다.
- Git status in the Files tree is shown by tinting the file name and a single dot per row instead of M/U/D letters, folders show one dot for the strongest change inside, and rows are slightly denser.
  ko: 파일 트리의 Git 상태가 M/U/D 글자 대신 파일명 색조와 행당 점 하나로 표시되고, 폴더는 안쪽의 가장 강한 변경을 점 하나로 보여주며 행 밀도가 조금 높아졌습니다.
- Open documents are shown as underline tabs whose close button appears on hover, a changed-on-disk document shows a dot in the close slot and reloads when clicked, middle-click closes a tab, and overflowing tabs open a list instead of a "+N" counter.
  ko: 열린 문서가 밑줄 탭으로 표시되어 닫기 버튼은 마우스를 올릴 때만 나타나고, 디스크에서 바뀐 문서는 닫기 자리에 점이 표시되어 클릭하면 다시 읽으며, 가운데 클릭으로 탭을 닫고 넘친 탭은 "+N" 대신 목록으로 열립니다.
- The Files tree shows skeleton rows while loading, a delayed ring while a folder expands, an illustrated empty-folder state with a hidden-files shortcut, a retry card when loading fails, and fades at scrollable edges of the tree and code viewer.
  ko: 파일 트리가 불러오는 동안 골격 행을, 폴더를 펼치는 동안 지연 링을, 빈 폴더에는 숨김 파일 바로가기가 있는 안내를, 로드 실패에는 다시 시도 카드를 보여주고, 트리와 코드 뷰어의 스크롤 가장자리가 옅어집니다.

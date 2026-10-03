---
branch: surface-linking
---

### fleet-console
#### Added
- Cmd-click (Ctrl-click elsewhere) a `path:line:col` in Shell or agent terminal output, or a file link in Markdown, to open that file in Files at the exact line; the palette and the Files filter also accept `path:line:col`, `path(line,col)` and absolute paths, and an exact file match comes first.
  ko: Shell이나 에이전트 터미널 출력의 `path:line:col`을 ⌘클릭(그 밖의 OS에서는 Ctrl+클릭)하거나 Markdown의 파일 링크를 누르면 Files가 해당 줄에서 파일을 엽니다. 팔레트와 Files 필터도 `path:line:col`, `path(line,col)`, 절대 경로를 받으며 정확히 일치하는 파일이 맨 위에 옵니다.
- File links in the wiki reader open an inline preview of the code at the linked line, with a one-step move to Files, and wiki links in Files previews open the wiki entry.
  ko: 위키 리더의 파일 링크를 누르면 연결된 줄의 코드를 리더 안에서 미리 보고 바로 Files로 옮길 수 있으며, Files 미리보기의 위키 링크는 해당 위키 문서를 엽니다.
- Files, the wiki and the Shell show which Theater they are working in; the Shell also shows its current folder and warns when it is in a different Theater than the one you are viewing, with actions to move it there or start a new Shell.
  ko: Files·위키·Shell이 지금 어느 Theater에서 동작하는지 보여 주고, Shell은 현재 폴더도 표시합니다. 보고 있는 Theater와 Shell의 위치가 다르면 경고하고 그 Theater로 옮기거나 새 Shell을 시작할 수 있습니다.
- Open the Shell at a folder from the Files context menu; it never types into a running program or a half-typed command line.
  ko: Files 메뉴에서 선택한 폴더 위치로 Shell을 열 수 있으며, 실행 중인 프로그램이나 입력 중인 명령줄에는 아무것도 입력하지 않습니다.
- Search the terminal with Cmd-F (Ctrl-Shift-F elsewhere), keep up to 50,000 lines of scrollback (10,000 by default), and turn copy-on-select off in Settings.
  ko: ⌘F(그 밖의 OS에서는 Ctrl+Shift+F)로 터미널 안을 검색하고, 스크롤백을 최대 50,000줄(기본 10,000줄)까지 보관하며, 설정에서 선택 시 자동 복사를 끌 수 있습니다.

#### Changed
- The Shell keeps at least 80 columns when Files, the wiki reader or Settings open beside it; documents, readers and Settings float over it instead of squeezing it, so the running program is not resized.
  ko: Files·위키 리더·설정을 함께 열어도 Shell이 최소 80열을 유지합니다. 공간이 모자라면 문서·리더·설정 창이 Shell을 줄이지 않고 그 위에 떠서, 실행 중인 프로그램의 화면 크기가 바뀌지 않습니다.
- Files reopens the document window you had in each Theater when you come back to it.
  ko: Files가 Theater를 다시 열 때 그 Theater에서 보던 문서 창을 되살립니다.

#### Fixed
- Relative file links in the wiki reader and in agent chat no longer reload the whole Console.
  ko: 위키 리더와 에이전트 채팅의 상대 파일 링크를 눌러도 Console 전체가 다시 로드되지 않습니다.
- The wiki's Cowork settings shortcut opens the Cowork model setting itself.
  ko: 위키 Cowork의 설정 바로가기가 Cowork 모델 설정으로 바로 이동합니다.

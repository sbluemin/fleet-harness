---
branch: palette-proposal-0912
---

### fleet-console
#### Added
- The search palette now has four tabs (Operations, Commands, Theaters, Panels) that the `>` `#` `@` prefixes also reach; Operation rows open an inline action strip with the right arrow (open, resume, rename, minimize, close), and a legend at the bottom shows the palette's own keys.
  ko: 검색 팔레트에 네 탭(Operation·명령·Theater·패널)이 생겼고 `>` `#` `@` 접두로도 같은 탭에 닿습니다. Operation 행에서 오른쪽 화살표로 동작 띠(열기·재개·이름 변경·최소화·닫기)를 열 수 있고, 창 바닥 범례가 팔레트의 키를 보여 줍니다.
- The command tab's empty screen is a grouped home (recent, current Operation, Theater, view, panels, Console) with a glyph per row and section, keyboard shortcut hints on rows, and the destructive close command shown in coral with an undo marker.
  ko: 명령 탭의 빈 화면이 구역 홈(최근 실행·현재 Operation·Theater·화면·패널·Console)이 됐고, 행과 구역마다 글리프, 행 오른쪽에 단축키 힌트, 파괴 명령(닫기)은 coral 잉크와 되돌리기 표식으로 섭니다.
#### Changed
- `Cmd/Ctrl+K` now closes an open palette and returns the command tab to Operations, and `Cmd/Ctrl+P` switches an open palette to the command tab instead of doing nothing.
  ko: 열린 팔레트에서 `Cmd/Ctrl+K`는 창을 닫거나 명령 탭을 Operation 탭으로 되돌리고, `Cmd/Ctrl+P`는 아무 일도 하지 않던 것에서 명령 탭으로 전환합니다.
- Commands match in both languages (`>sidebar` finds the sidebar toggle in a Korean UI), Operation search uses the same fuzzy rule as commands, and results list the active Theater first with recently focused Operations on top.
  ko: 명령이 한·영 양쪽으로 맞고(`>sidebar`로 사이드바 전환), Operation 검색이 명령과 같은 퍼지 규칙을 쓰며, 결과는 활성 Theater가 먼저 서고 그 안은 최근 포커스 순입니다.

---
branch: feat/commodore-theater-add-ui
---

### fleet-console
#### Added
- Create a commodore from the sidebar's top "+" and add any number of Theaters to it from its operations pane, including a Theater another commodore already uses. Objectives a commodore runs work in the commodore's own folder with its Theaters attached, while ordinary sessions still run in the Theater you choose.
  ko: 사이드바 맨 위 '+'로 사령관을 만들고, 작전 구역에서 Theater를 원하는 만큼 추가할 수 있습니다. 다른 사령관이 쓰는 Theater도 추가할 수 있습니다. 사령관이 실행하는 목표는 추가한 Theater를 함께 다루며 사령관 폴더에서 작업하고, 일반 세션은 지금처럼 고른 Theater에서 실행됩니다.
#### Changed
- The sidebar groups sessions by commodore, and system prompt and subagent settings now belong to each commodore in its Settings tab; existing Theater settings carry over to the commodore that had that Theater.
  ko: 사이드바는 사령관별로 세션을 묶고, 시스템 프롬프트와 서브에이전트 설정은 사령관의 설정 탭에서 사령관마다 관리합니다. 기존 Theater 설정은 그 Theater를 가진 사령관으로 옮겨집니다.
#### Breaking Changes
- After using empty, multiple, or shared Theater assignments, downgrading to an older Console may hide affected Commodores and their boards until you upgrade again; their files remain on disk.
  ko: Theater가 없거나 여러 개이거나 다른 사령관과 공유하는 구성을 사용한 뒤 구버전 Console로 돌아가면 해당 사령관과 보드가 다시 업그레이드할 때까지 보이지 않을 수 있으며, 파일은 디스크에 남습니다.

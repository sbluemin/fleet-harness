---
branch: plugin-snapshot-store
---

### fleet-console
#### Fixed
- Keep a running session's delegation policy intact: each Claude session now gets its own Fleet plugin tree under its workspace, so launching another session no longer swaps the delegation guard, skills, or gateway identities out from under sessions already running.
  ko: 실행 중 세션의 위임 정책을 지킵니다. Claude 세션마다 자기 워크스페이스 아래에 고유한 Fleet 플러그인 트리를 갖게 되어, 다른 세션을 새로 띄워도 이미 실행 중인 세션의 위임 가드·스킬·게이트웨이 정체성이 바꿔치기되지 않습니다.
- Chat Mode and the terminal now receive one session definition instead of assembling their own, so the same Operation no longer gains different skills or setting layers depending on which surface opened it.
  ko: Chat Mode와 터미널이 각자 조립하는 대신 하나의 세션 정의를 받습니다. 같은 Operation을 어느 표면으로 열었는지에 따라 스킬이나 설정 층이 달라지지 않습니다.
#### Changed
- A new Operation now opens its Claude session under the Operation's own id, so its resume coordinate is known the moment it is created instead of after the first turn reports back.
  ko: 새 Operation은 자기 id로 Claude 세션을 엽니다. 재개 좌표가 첫 턴의 보고를 기다리지 않고 생성 시점에 확정됩니다.
- A Chat session that cannot load its Fleet plugin now refuses the turn with a visible error instead of quietly running without skills, identities, and the delegation guard.
  ko: Fleet 플러그인을 싣지 못한 Chat 세션은 스킬·정체성·위임 가드 없이 조용히 돌던 동작 대신, 눈에 보이는 오류와 함께 그 턴을 거부합니다.

### fleet-cli
#### Fixed
- Claude Code passthrough sessions read their Fleet policy hooks from their own session tree for their whole life, so a Console launch or another `fleet` run can no longer rewrite them mid-session.
  ko: Claude Code 패스스루 세션이 Fleet 정책 훅을 세션 수명 내내 자기 세션 트리에서 읽으므로, Console 런치나 다른 `fleet` 실행이 세션 도중 그 훅을 다시 쓰지 못합니다.
#### Changed
- The old shared `marketplace/` plugin tree is no longer written, and Fleet reclaims what it left there once no older `fleet` release has rendered into it for a week.
  ko: 예전의 공유 `marketplace/` 플러그인 트리에 더는 쓰지 않으며, 일주일 동안 구버전 `fleet`이 그 트리를 렌더하지 않으면 Fleet이 자기가 남긴 것을 걷어냅니다.

---
branch: plugin-snapshot-store
---

### fleet-console
#### Fixed
- Keep a running session's delegation policy intact: Fleet plugin assets now publish as immutable content-addressed snapshots, so launching another session no longer swaps the delegation guard, skills, or gateway identities out from under sessions already running.
  ko: 실행 중 세션의 위임 정책을 지킵니다. Fleet 플러그인 자산이 내용 주소 기반 불변 스냅숏으로 발행되어, 다른 세션을 새로 띄워도 이미 실행 중인 세션의 위임 가드·스킬·게이트웨이 정체성이 바꿔치기되지 않습니다.
#### Changed
- A Chat session that cannot load its Fleet plugin now refuses the turn with a visible error instead of quietly running without skills, identities, and the delegation guard.
  ko: Fleet 플러그인을 싣지 못한 Chat 세션은 스킬·정체성·위임 가드 없이 조용히 돌던 동작 대신, 눈에 보이는 오류와 함께 그 턴을 거부합니다.

### fleet-cli
#### Fixed
- Claude Code passthrough sessions read their Fleet policy hooks from an immutable snapshot for their whole life, so a Console launch or another `fleet` run can no longer rewrite them mid-session.
  ko: Claude Code 패스스루 세션이 Fleet 정책 훅을 세션 수명 내내 불변 스냅숏에서 읽으므로, Console 런치나 다른 `fleet` 실행이 세션 도중 그 훅을 다시 쓰지 못합니다.

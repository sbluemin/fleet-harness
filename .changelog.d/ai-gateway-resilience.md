---
branch: ai-gateway-resilience
---

### fleet-console
#### Fixed
- Recover a gateway turn that a provider drops or refuses, instead of ending it on the first attempt. Transient failures now reach Claude Code as statuses its own retry budget acts on, so an interruption that one more attempt would clear no longer surfaces as an API error.
  ko: 공급자가 끊거나 거절한 게이트웨이 턴을 첫 시도에서 끝내지 않고 복구합니다. 일시적 실패가 Claude Code의 재시도 예산이 반응하는 상태로 전달되므로, 한 번만 더 시도하면 지나갈 중단이 API 오류로 드러나지 않습니다.
- Cap how many upstream connections a single Console holds per provider, so a wide fan-out queues instead of opening a connection per agent and losing streams to the pressure.
  ko: 하나의 Console이 공급자당 유지하는 업스트림 연결 수에 상한을 두어, 폭넓은 팬아웃이 에이전트마다 연결을 여는 대신 대기하도록 하고 그 부하로 스트림을 잃지 않게 합니다.
- Record every failed gateway turn to a durable log, so an interruption that used to vanish after one on-screen notice can be diagnosed afterwards.
  ko: 실패한 게이트웨이 턴을 지속 로그에 기록하여, 화면에 한 번 표시되고 사라지던 중단을 사후에 진단할 수 있게 합니다.

### fleet-cli
#### Fixed
- Recover a gateway turn that a provider drops or refuses, instead of ending it on the first attempt. Transient failures now reach Claude Code as statuses its own retry budget acts on, so an interruption that one more attempt would clear no longer surfaces as an API error.
  ko: 공급자가 끊거나 거절한 게이트웨이 턴을 첫 시도에서 끝내지 않고 복구합니다. 일시적 실패가 Claude Code의 재시도 예산이 반응하는 상태로 전달되므로, 한 번만 더 시도하면 지나갈 중단이 API 오류로 드러나지 않습니다.
- Cap how many upstream connections the launcher holds per provider, so a wide fan-out queues instead of opening a connection per agent and losing streams to the pressure.
  ko: 런처가 공급자당 유지하는 업스트림 연결 수에 상한을 두어, 폭넓은 팬아웃이 에이전트마다 연결을 여는 대신 대기하도록 하고 그 부하로 스트림을 잃지 않게 합니다.
- Record every failed gateway turn to a durable log, so an interruption that used to vanish after one on-screen notice can be diagnosed afterwards.
  ko: 실패한 게이트웨이 턴을 지속 로그에 기록하여, 화면에 한 번 표시되고 사라지던 중단을 사후에 진단할 수 있게 합니다.

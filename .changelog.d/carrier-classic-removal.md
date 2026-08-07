---
branch: carrier-classic-removal
---

### fleet-console
#### Breaking Changes
- Retire the Claude (Classic) launch kind. New Operations launch as Claude (Native) or Claude (Gateway), and every existing Classic Operation moves to Claude (Gateway) once on first start, restored Operations inside the undo window included. The console keeps a one-time `state.json.classic-backup` beside its durable state before it rewrites anything.
  ko: Claude (Classic) 실행 종류를 폐지합니다. 새 Operation은 Claude (Native) 또는 Claude (Gateway)로 시작하고, 기존 Classic Operation은 첫 기동 때 한 번에 Claude (Gateway)로 이주합니다. 되돌리기 대기 중인 Operation도 함께 이주하며, 이주 직전 상태는 `state.json.classic-backup`으로 한 번 보관합니다.
- Remove the Carrier surfaces the Classic launch kind carried: the Carrier Streams panel and its companion, the Carrier settings section, and the Carrier deep-link target in Global Settings. Agent session status, attention, and title behavior are unchanged.
  ko: Classic 실행 종류가 데리고 있던 Carrier 표면을 제거합니다. Carrier Streams 패널과 컴패니언, Carrier 설정 구역, 전역 설정의 Carrier 딥링크 대상이 사라집니다. 에이전트 세션 상태·주의 표시·제목 동작은 그대로입니다.
- Remove the Metaphor prompt setting. It only shaped the Classic prompt persona, so it no longer appears in Terminal settings and is dropped from stored settings on the next write.
  ko: Metaphor 프롬프트 설정을 제거합니다. Classic 프롬프트의 어조에만 관여하던 설정이라 Terminal 설정에서 사라지고, 다음 저장 때 보관된 설정에서도 정리됩니다.

### fleet-cli
#### Breaking Changes
- Resolve `FLEET_AGENT_CLI=claude` to the gateway launch instead of the retired Classic launch, so an environment that still exports the old value keeps starting.
  ko: `FLEET_AGENT_CLI=claude`를 폐지된 Classic 대신 게이트웨이 실행으로 해석합니다. 옛 값을 그대로 내보내 둔 환경도 계속 기동합니다.

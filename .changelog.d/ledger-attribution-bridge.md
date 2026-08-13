---
branch: ledger-attribution-bridge
---

### fleet-console
#### Added
- Reconcile the Ledger hero with device-wide spend: an attribution bridge under the summary splits the window's cost into Console-attributed operations and other local sessions, with the device-wide total named in the same block.
  ko: Ledger 주요 수치와 기기 전체 지출을 맞춰 봅니다. 요약 아래 귀속 브릿지가 해당 기간 비용을 Console 귀속 Operation과 기타 로컬 세션으로 나누어 보여 주고, 기기 전체 합계를 함께 표시합니다.
- Keep Operations visible in Ledger when their saved session has no matched usage in the window: they render as dimmed ghost rows with a matched/unmatched coverage line, and the operation list gains a recent-activity / highest-cost sort toggle.
  ko: 저장 세션은 있지만 해당 기간에 매칭된 사용량이 없는 Operation을 Ledger에서 지우지 않습니다. 흐린 유령 행과 매칭/미매칭 커버리지 라인으로 표시하고, Operation 목록에 최근 활동/비용 높은 순 정렬 토글을 추가합니다.

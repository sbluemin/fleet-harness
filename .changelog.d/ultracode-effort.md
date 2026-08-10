---
branch: ultracode-effort
---

### fleet-console
#### Added
- Offer ULTRACODE on the launch effort gauge, which runs Claude Code at XHIGH reasoning with dynamic workflow orchestration turned on for that session. Gateway models offer it only when the model can honour XHIGH, so the rung you pick is never quietly reduced upstream.
  ko: 실행 강도 게이지에 ULTRACODE를 추가했습니다. Claude Code를 XHIGH 추론으로 실행하면서 그 세션에 한해 dynamic workflow 오케스트레이션을 켭니다. XHIGH를 소화할 수 있는 게이트웨이 모델에만 내주므로, 고른 단이 상류에서 조용히 깎이지 않습니다.

#### Changed
- Stop the ordinary effort rail at XHIGH and keep MAX and ULTRACODE behind a gate on the gauge, so the costly rungs take a deliberate press instead of a stray drag. Opening the gate states the cost and keeps it on screen, picking one of these rungs arms it without launching, and neither rung is carried over from disk or from the model you switched away from.
  ko: 평범한 강도 레일을 XHIGH에서 끊고 MAX와 ULTRACODE를 게이지의 게이트 뒤에 두었습니다. 비용이 큰 단은 스쳐 지나간 드래그가 아니라 분명한 조작으로만 닿습니다. 게이트를 열면 비용을 밝혀 화면에 남기고, 이 단을 고르는 것은 실행이 아니라 장전까지이며, 디스크나 직전 모델에서 물려받지도 않습니다.
- Run a drifting spectrum across the gauge while MAX or ULTRACODE is loaded, so a session-only expensive mode keeps announcing itself instead of resting on one more notch of the ordinary ramp. Reduced-motion settings keep the spectrum and drop the drift.
  ko: MAX나 ULTRACODE가 실린 동안에는 게이지에 스펙트럼이 흐릅니다. 세션 한정 고비용 모드가 평범한 램프의 한 칸 더로 보이지 않고 계속 자기를 알립니다. 모션을 줄인 환경에서는 색은 남기고 흐름만 걷어 냅니다.

---
branch: console-use-product
---

### fleet-console
#### Fixed
- Chat uses the same configured Claude Code executable as Terminal, keeping native model aliases consistent when switching views; update Claude Agent SDK to 0.3.269.
  ko: Chat이 Terminal과 동일하게 설정된 Claude Code 실행기를 사용하여 화면 전환 시 네이티브 모델 별칭이 일치하도록 하며, Claude Agent SDK를 0.3.269로 업데이트합니다.
#### Added
- Extend fleet-console-use with host-observed Operation context, filtered reads, public Chat results and bounded event waits; opt in to Console use under Experiments to let Quaker Aides and Console agents launch and direct Operations, inspect results and manage limited automations without individual approval, with persisted receipts, retry deduplication, expiry and attempt budgets; Quaker Aides also read the fleet-ai-gateway model roster so an Operation launches with the exact exposed gateway model instead of a guessed name. An Operation reaches the Console only after you allow it from that Operation's own panel: every Console tool call, reads included, is refused until then, and allowing or revoking it takes effect on the next call without restarting or reconnecting the session. A refusal tells the agent which switch is off and where to turn it on, and revoking also pauses the automations that Operation owns.
  ko: fleet-console-use에 호스트가 관측한 Operation 컨텍스트, 조건부 조회, 공개 Chat 결과와 제한된 이벤트 대기를 추가합니다. 실험 기능의 콘솔 사용을 켜면 퀘이커 부관단과 Console 에이전트가 Operation 실행·지시·결과 확인과 제한된 자동 운영을 개별 확인 없이 수행하며, 실행 기록 영속화, 재시도 중복 방지, 만료와 시도 횟수 예산을 제공합니다. 퀘이커 부관단은 fleet-ai-gateway 모델 로스터도 읽어, 추측한 이름이 아니라 노출된 정확한 게이트웨이 모델로 Operation을 띄웁니다. Operation은 자기 패널에서 허용해야 Console에 닿습니다. 그전까지는 조회를 포함한 모든 Console 도구 호출이 거부되며, 허용과 거둠은 세션을 다시 시작하거나 연결하지 않아도 다음 호출부터 적용됩니다. 거부 응답은 어느 스위치가 꺼져 있고 어디서 켜야 하는지를 알려 주고, 허용을 거두면 그 Operation이 소유한 자동 운영도 함께 멈춥니다.

---
branch: console-use-product
---

### fleet-console
#### Fixed
- Chat uses the same configured Claude Code executable as Terminal, keeping native model aliases consistent when switching views; update Claude Agent SDK to 0.3.269.
  ko: Chat이 Terminal과 동일하게 설정된 Claude Code 실행기를 사용하여 화면 전환 시 네이티브 모델 별칭이 일치하도록 하며, Claude Agent SDK를 0.3.269로 업데이트합니다.
#### Added
- Extend fleet-console-use with host-observed Operation context, filtered reads, public Chat results and bounded event waits; opt in to Console use under Experiments to let Quaker Aides and Console agents launch and direct Operations, inspect results and manage limited automations without individual approval, with persisted receipts, retry deduplication, expiry and attempt budgets.
  ko: fleet-console-use에 호스트가 관측한 Operation 컨텍스트, 조건부 조회, 공개 Chat 결과와 제한된 이벤트 대기를 추가합니다. 실험 기능의 콘솔 사용을 켜면 퀘이커 부관단과 Console 에이전트가 Operation 실행·지시·결과 확인과 제한된 자동 운영을 개별 확인 없이 수행하며, 실행 기록 영속화, 재시도 중복 방지, 만료와 시도 횟수 예산을 제공합니다.

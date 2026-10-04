---
branch: fix/cu-injection-gate
---

### fleet-console
#### Fixed
- Agent sessions started while Computer Use is off no longer receive Computer Use tools. Turning Computer Use on applies from the next session start or resume, and turning it off refuses calls from running sessions right away instead of waiting for an answer.
  ko: 컴퓨터 사용을 끈 상태에서 시작한 에이전트 세션에 더 이상 컴퓨터 사용 도구가 실리지 않습니다. 켜면 다음 세션 시작이나 재개부터 적용되고, 끄면 실행 중인 세션의 호출도 답을 기다리지 않고 바로 거절됩니다.

---
branch: fix/cursor-resample-gate
---

### fleet-console
#### Fixed
- A short Cursor turn that ends on a finished report, a question, or a request for approval is no longer pushed to continue.
  ko: 짧은 완료 보고나 질문, 승인 요청으로 끝난 Cursor 턴에는 더 이상 이어서 하라는 재요청을 보내지 않습니다.
- A Cursor turn that only announces its next step after a tool result followed by a skill body, a loaded-tool notice, nested project instructions, a background-task notice or a message from another session is now asked once more to make that call, as it already was after a reminder.
  ko: 도구 결과 뒤에 Skill 본문, 도구 로드 알림, 하위 프로젝트 지시, 백그라운드 작업 알림, 다른 세션 메시지가 붙은 경우에도, 다음 단계를 예고만 하고 끝난 Cursor 턴에 리마인더 때와 같이 한 번 더 호출을 요청합니다.

---
branch: cursor-upstream-status-gate
---

### fleet-cli
#### Fixed
- Report why a Cursor turn failed instead of ending it with an empty reply. When Cursor rejected a request outright (an expired sign-in, a usage limit, a gateway in front of it answering with an error page), the reply body was not the streaming format the gateway reads, so nothing decoded, the turn simply ended, and Claude Code received a successful but empty assistant message with no stated cause. The gateway now waits for Cursor's response status before reading anything as model output, passes a rejection through with that status and Cursor's own message, and treats a turn that produced no output at all as a failure rather than a completed answer.
  ko: Cursor 턴이 실패한 이유를 빈 응답 대신 그대로 보고합니다. 지금까지는 Cursor가 요청을 거절하면(로그인 만료, 사용량 제한, 앞단 게이트웨이의 오류 페이지) 응답 본문이 게이트웨이가 읽는 스트리밍 형식이 아니어서 아무것도 해석되지 않고 턴이 그냥 끝났고, Claude Code는 원인 없이 성공한 빈 어시스턴트 메시지를 받았습니다. 이제 게이트웨이는 Cursor의 응답 상태를 확인한 뒤에야 본문을 모델 출력으로 읽고, 거절은 그 상태와 Cursor가 보낸 메시지 그대로 전달하며, 출력이 하나도 없는 턴은 완료된 답변이 아니라 실패로 처리합니다.

### fleet-console
#### Fixed
- Report why a Cursor turn failed instead of ending it with an empty reply. When Cursor rejected a request outright (an expired sign-in, a usage limit, a gateway in front of it answering with an error page), the reply body was not the streaming format the gateway reads, so nothing decoded, the turn simply ended, and the session received a successful but empty assistant message with no stated cause. The gateway now waits for Cursor's response status before reading anything as model output, passes a rejection through with that status and Cursor's own message, and treats a turn that produced no output at all as a failure rather than a completed answer.
  ko: Cursor 턴이 실패한 이유를 빈 응답 대신 그대로 보고합니다. 지금까지는 Cursor가 요청을 거절하면(로그인 만료, 사용량 제한, 앞단 게이트웨이의 오류 페이지) 응답 본문이 게이트웨이가 읽는 스트리밍 형식이 아니어서 아무것도 해석되지 않고 턴이 그냥 끝났고, 세션은 원인 없이 성공한 빈 어시스턴트 메시지를 받았습니다. 이제 게이트웨이는 Cursor의 응답 상태를 확인한 뒤에야 본문을 모델 출력으로 읽고, 거절은 그 상태와 Cursor가 보낸 메시지 그대로 전달하며, 출력이 하나도 없는 턴은 완료된 답변이 아니라 실패로 처리합니다.

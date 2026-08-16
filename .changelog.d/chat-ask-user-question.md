---
branch: chat-ask-user-question
---

### fleet-console
#### Added
- Answer the agent inside the chat view. When the model stops to ask which way to go, the question stands as a card where it was asked, so you can pick an option or type an answer of your own, and the turn continues from your choice. A plan the model submits for review arrives the same way: approve it, or ask for a change and it comes back revised.
  ko: 채팅 뷰 안에서 에이전트에게 답합니다. 모델이 갈림길에서 멈춰 물으면 그 자리에 질문 카드가 서고, 선택지를 고르거나 직접 답을 써 넣으면 그 답으로 턴이 이어집니다. 모델이 검토를 요청한 계획도 같은 자리에서 받습니다 — 승인하거나, 바꿀 점을 쓰면 계획을 고쳐 다시 냅니다.
- Show a waiting operation as waiting. While the chat view holds a question, the sidebar chip, War Room tile, and map dot read it as awaiting input rather than working, so a question you have not opened still finds you. The session waits until you answer or skip it, and never times out on its own.
  ko: 답을 기다리는 Operation을 기다림으로 표시합니다. 채팅 뷰가 질문을 들고 있는 동안 사이드바 칩·War Room 타일·맵 도트가 "작업 중"이 아니라 "입력 대기"로 읽혀, 열어 보지 않은 질문도 사용자를 찾아옵니다. 세션은 답하거나 건너뛸 때까지 기다립니다 — 스스로 시간이 지나 닫히지 않습니다.

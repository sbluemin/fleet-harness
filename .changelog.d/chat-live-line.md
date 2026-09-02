---
branch: chat-live-line
---

### fleet-console
#### Changed
- Show one live line per chat turn: the tally tail now says "Thinking..." during model gaps instead of a boxed row, the ring and shimmer only run while that tail says something, and streaming answers carry a caret and a fading last line.
  ko: 채팅 턴마다 살아 있는 줄을 하나만 둡니다. 모델이 생각하는 공백에는 집계 줄 꼬리가 "생각 중…"을 말하고(별도 상자 없음), 링과 물결은 꼬리가 무엇인가를 말할 때만 돌며, 흐르는 응답에는 캐럿과 마지막 줄 옅어짐이 붙습니다.
- Leave a "Thought for Ns" trace in the tally after each live thinking gap, so a long turn explains where its time went without exposing any thinking content.
  ko: 라이브 생각 공백이 끝나면 집계 줄에 "N초 생각함" 흔적을 남겨, 긴 턴이 어디에 시간을 썼는지 생각 내용 없이도 읽히게 합니다.
- Replace the chat ledger's text glyphs (tally families, job anchors, work pane, Session Analyst sigils) with a uniform monoline icon set.
  ko: 채팅 원장의 문자 글리프(집계 계열·잡 앵커·작업 면·세션 분석가 시길)를 무게가 균일한 모노라인 아이콘 세트로 교체합니다.
#### Fixed
- Tint running and failed step borders in oklab so the Whites theme no longer shows a greenish edge instead of the status color.
  ko: 진행 중·실패 스텝 테두리를 oklab으로 섞어 Whites 테마에서 상태색 대신 녹회색 테두리가 보이던 문제를 고칩니다.

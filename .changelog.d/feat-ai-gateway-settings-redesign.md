---
branch: feat/ai-gateway-settings-redesign
---

### fleet-console
#### Changed
- AI Gateway settings list each model on one line: turn it on to make it a delegation candidate, pick one context window and Fast, and keep low-high on while xhigh and max stay optional.
  ko: AI Gateway 설정은 모델마다 한 줄이에요. 켜면 위임 후보가 되고, 컨텍스트 창과 Fast는 하나씩만 고르며, low–high는 항상 켜고 xhigh·max만 선택해요.
- Console model menus and Claude Code /model now list every model and effort from signed-in providers, whether or not that model is a delegation candidate. Signed-out providers stay hidden. Turning off the Claude usage connection does not hide Claude models. Delegation offers the same set: an enabled model whose provider is not signed in is not assigned.
  ko: Console 모델 메뉴와 Claude Code /model은 위임 후보와 상관없이, 로그인한 공급자의 모든 모델과 강도를 보여 줘요. 로그아웃한 공급자는 숨겨요. Claude 사용량 연결을 꺼도 Claude 모델은 숨기지 않아요. 위임도 같은 목록이에요. 로그인되지 않은 공급자의 켠 모델은 배정하지 않아요.
- Existing AI Gateway selections drop host-only models from the delegation list, keep one variant per model (the largest context window), and fill in low-high.
  ko: 저장돼 있던 AI Gateway 선택은 호스트 전용 모델을 위임 목록에서 빼고, 모델마다 창이 가장 큰 변형 하나만 남기며, low–high를 채워요.

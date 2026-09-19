---
branch: console-use-dormant-removal
---

### fleet-console
#### Added
- Agents using the Console can put an idle terminal Operation to sleep: its process ends, the card stays on the Ended shelf, and Resume brings it back with its session.
  ko: Console 을 쓰는 에이전트가 유휴 터미널 Operation 을 휴면으로 보낼 수 있습니다. 프로세스는 끝나고 카드는 「종료됨」 선반에 남아, 재개하면 세션 그대로 돌아옵니다.
#### Fixed
- An Operation closed by an agent or from another window now leaves the sidebar and canvas immediately, and undoing the close brings it back everywhere without a refresh.
  ko: 에이전트나 다른 창에서 닫은 Operation 이 사이드바와 캔버스에서 바로 사라지고, 닫기를 되돌리면 새로고침 없이 모든 화면에 다시 나타납니다.

---
branch: fix-companion-layer-jump
---

### fleet-console
#### Fixed
- Opening or closing the Session Analyst or Fleet Browser from an Operation's caption now glides the Operation from where it stands, instead of jumping from the wrong place first when the sidebar is open or the canvas is zoomed or panned.
  ko: Operation 캡션에서 세션 분석가나 Fleet Browser를 열고 닫을 때, 사이드바가 열려 있거나 캔버스를 확대·이동한 상태에서도 Operation이 엉뚱한 위치로 튀지 않고 지금 자리에서 미끄러지듯 이동합니다.
- Operations on the canvas now move together with the left sidebar as it opens or closes, instead of snapping to their final place ahead of it.
  ko: 좌측 사이드바를 열고 닫을 때 캔버스의 Operation이 사이드바보다 먼저 최종 위치로 순간 이동하지 않고 사이드바와 함께 움직입니다.

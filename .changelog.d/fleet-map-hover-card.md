---
branch: fleet-map-hover-card
---

### fleet-console
#### Added
- See every Operation on a fleet map in War Room: zoom the deck out past 1.0x, or use the Fleet map button, Alt+M, or the command palette, even while a request is on stage. Pick a waiting Operation to bring it to the stage; point at any other one to read its full title, status, location with branch, model, and last output line, or take a quick look without changing the stage.
  ko: War Room에서 덱을 1.0× 아래로 줄이거나 함대 지도 버튼·Alt+M·명령 팔레트를 쓰면, 무대에 요청이 올라 있어도 모든 Operation을 함대 지도로 볼 수 있습니다. 대기 중인 Operation을 고르면 무대에 오르고, 그 밖의 Operation은 가리켜 전체 제목·상태·브랜치를 포함한 위치·모델·마지막 출력 줄을 읽거나, 무대를 바꾸지 않고 빠른 보기로 살펴볼 수 있습니다.

#### Changed
- Zooming the Cruise canvas out no longer turns it into a fleet map; the fleet map now opens in War Room.
  ko: Cruise 캔버스를 축소해도 더 이상 함대 지도로 바뀌지 않습니다. 함대 지도는 이제 War Room에서 엽니다.

#### Fixed
- War Room counts set-aside requests separately, so the deck no longer reports waiting work while the queue says nothing is waiting.
  ko: War Room이 치워둔 요청을 따로 세어, 대기열에는 기다리는 작업이 없는데 덱이 대기 건을 표시하는 일이 없습니다.

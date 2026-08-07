---
branch: warroom-preview-width
---

### fleet-console
#### Fixed
- Keep every column of a War Room Watch Deck card preview inside its frame. The card scaled the panel to whichever axis needed more magnification, so a card taller than the panel's output area pushed the left and right edges out of frame and cut the start of every line, which is what raising the deck density produced: the card's padding, status row and title stay a fixed size while the row grows. The card preview now locks to the frame width and absorbs the difference vertically, leaving a strip of empty backdrop above the output instead of trimming characters. The newest rows stay anchored to the bottom edge as before, and a quick-look still opens its panel at actual size, showing as much of the line as the window holds.
  ko: War Room Watch Deck 카드 프리뷰의 모든 열이 프레임 안에 남습니다. 카드는 더 큰 배율이 필요한 축을 기준으로 패널을 키웠기 때문에, 카드가 패널 출력 영역보다 세로로 길면 좌우가 프레임 밖으로 밀려 모든 줄의 시작이 잘렸습니다. 카드의 패딩·상태줄·제목은 고정 크기인데 행만 커지므로 덱 밀도를 올릴수록 이 상태가 됐습니다. 이제 카드 프리뷰는 프레임 폭에 맞춰 고정되고 차이를 세로로 흡수해, 글자를 잘라내는 대신 출력 위쪽에 빈 배경 띠를 남깁니다. 최신 행은 종전처럼 하단에 붙어 있고, 확대창은 계속 패널을 실제 크기로 열어 창이 담는 만큼의 줄을 보여줍니다.

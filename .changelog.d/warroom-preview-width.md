---
branch: warroom-preview-width
---

### fleet-console
#### Fixed
- Fit a War Room Watch Deck card preview to its card at every deck density. The card scaled the panel to whichever axis needed more magnification, so a card taller than the panel's output area pushed the left and right edges out of frame and cut the start of every line, which is what raising the deck density produced: the card's padding, status row and title stay a fixed size while the row grows. The preview now locks to the frame width, and the frame takes the shape of the output it holds, so the output fills it at every density rather than trimming characters or sitting under a band of empty backdrop. The newest rows stay anchored to the bottom edge, and a quick-look still opens its panel at actual size, showing as much of the line as the window holds from the start of each line.
  ko: War Room Watch Deck 카드 프리뷰가 모든 덱 밀도에서 카드에 맞습니다. 카드는 더 큰 배율이 필요한 축을 기준으로 패널을 키웠기 때문에, 카드가 패널 출력 영역보다 세로로 길면 좌우가 프레임 밖으로 밀려 모든 줄의 시작이 잘렸습니다. 카드의 패딩·상태줄·제목은 고정 크기인데 행만 커지므로 덱 밀도를 올릴수록 이 상태가 됐습니다. 이제 프리뷰는 프레임 폭에 맞춰 고정되고, 프레임 자체가 담고 있는 출력의 모양을 따르므로, 글자가 잘리지도 빈 배경 띠가 위에 남지도 않고 어느 밀도에서든 출력이 프레임을 채웁니다. 최신 행은 하단에 붙어 있고, 확대창은 계속 패널을 실제 크기로 열어 창이 담는 만큼의 줄을 줄 시작부터 보여줍니다.

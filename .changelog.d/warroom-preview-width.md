---
branch: warroom-preview-width
---

### fleet-console
#### Fixed
- Keep a War Room Watch Deck card preview filling its card, and grow the text with the card. The preview used to be centred when it overflowed sideways, so raising the deck density cut the start of every line and left the output unreadable. It now anchors to the frame's left edge: whichever way it overflows, every line still begins inside the frame and only the far right runs past it. The output fills the frame at every density instead of sitting under a band of empty backdrop, and because the frame drives the magnification, text grows as the card grows, roughly four times larger at the highest density than at the lowest. The newest rows stay anchored to the bottom edge, and a quick-look still opens its panel at actual size.
  ko: War Room Watch Deck 카드 프리뷰가 카드를 채우고, 글자도 카드에 맞춰 커집니다. 지금까지는 좌우로 넘칠 때 가운데를 기준으로 잘라 덱 밀도를 올릴수록 모든 줄의 시작이 사라지고 화면을 읽을 수 없었습니다. 이제 프리뷰는 프레임 왼쪽에 붙습니다 — 어느 쪽으로 넘치든 모든 줄의 시작은 프레임 안에 남고 오른쪽 끝만 밖으로 나갑니다. 어느 밀도에서든 출력이 빈 배경 띠 아래 놓이지 않고 프레임을 채우며, 배율을 프레임이 정하므로 카드가 커지는 만큼 글자도 커집니다(최고 밀도에서 최저 밀도의 약 네 배). 최신 행은 하단에 붙어 있고, 확대창은 계속 패널을 실제 크기로 엽니다.

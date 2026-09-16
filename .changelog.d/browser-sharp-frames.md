---
branch: browser-sharp-frames
---

### fleet-console
#### Changed
- The Operation Browser preview is now sharp when the page is still: text and colors are shown losslessly once scrolling or animation stops, and the frame is drawn pixel-for-pixel instead of being stretched to the panel.
  ko: Operation 브라우저 미리보기가 정지 상태에서 선명해집니다. 스크롤이나 애니메이션이 멈추면 글자와 색을 무손실로 보여 주고, 프레임을 패널에 맞춰 늘리지 않고 픽셀 그대로 그립니다.
#### Fixed
- Clicks, hovers, and annotations in the Operation Browser land on the right spot when the canvas is zoomed in or out, and the preview is captured at the zoomed sharpness.
  ko: 캔버스를 확대하거나 축소한 상태에서도 Operation 브라우저의 클릭·호버·주석이 정확한 위치에 닿고, 미리보기도 확대한 만큼 선명하게 찍힙니다.

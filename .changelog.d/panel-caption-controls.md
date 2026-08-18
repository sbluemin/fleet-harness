---
branch: panel-caption-controls
---

### fleet-console

#### Changed

- An Operation panel's own controls now live in its caption instead of floating over the body: Session Analyst, the chat/terminal switch, and the chat reading width stand as marks to the left of the panel menu, and every caption control names itself in a hover bubble. The reading width appears only in the chat view and steps aside on a narrow panel; a War Room card keeps its caption clear of them. With no chip row over the body, a chat log now starts at the top of the panel.
  ko: Operation 패널의 컨트롤이 본문 위에 떠 있지 않고 캡션으로 들어갔습니다. Session Analyst, 채팅/터미널 전환, 채팅 읽기 폭이 패널 메뉴 왼쪽에 마크로 서고, 캡션의 모든 컨트롤은 마우스를 올리면 말풍선으로 자기 이름을 말합니다. 읽기 폭은 채팅 뷰에서만 서고 좁은 패널에서는 물러나며, War Room 카드의 캡션에는 서지 않습니다. 본문 위의 칩 줄이 사라져 채팅 로그는 이제 패널 맨 위에서 시작합니다.
- The chat context meter moved from the floating chip row into the composer control row, one step to the left of the send control, so what is left in the window reads where the message is written.
  ko: 채팅 문맥 미터가 떠 있던 칩 줄에서 컴포저 컨트롤 행으로 옮겨, 전송 버튼 바로 왼쪽에 앉았습니다. 창에 얼마나 남았는지를 메시지를 쓰는 자리에서 읽습니다.

#### Fixed

- A pressed caption control (a maximized panel, an open Session Analyst) draws its brass fill on the brass hue in every theme; it previously landed on green or magenta because the color mix took the long way around the hue circle.
  ko: 눌린 상태의 캡션 컨트롤(최대화된 패널, 열린 Session Analyst)이 모든 테마에서 brass 색조로 그려집니다. 이전에는 색 혼합이 색상환을 먼 쪽으로 돌아 초록이나 자홍에 착지했습니다.

---
branch: light-liquid-glass
---

### fleet-console
#### Changed
- The light theme takes liquid glass again, and the Map is redesigned so the material can actually be seen. Cruise, Tactical and War Room now sit on a drawing board lit from a window at the upper left, with a graphite grid and a warm shade falling to the far corner, so panels, menus and console chrome have something behind them to bend. Transparency and blur policy match the dark themes throughout, terminal fields included: a panel now carries the desk through it instead of reading as flat paper.
  ko: 라이트 테마가 리퀴드 글래스를 다시 받습니다. 재질이 실제로 보이도록 Map도 함께 개편했습니다. Cruise·Tactical·War Room이 좌상단 창에서 빛이 드는 제도판 위에 서고, 흑연 격자와 먼 구석으로 떨어지는 따뜻한 그늘이 패널·메뉴·콘솔 크롬 뒤에 굴절시킬 것을 만듭니다. 투명도와 블러 정책은 터미널 필드까지 다크 테마와 같으며, 패널이 평평한 종이가 아니라 책상을 통과시켜 보여 줍니다.
- Light terminal text keeps its weight over the glass field. A cleared field costs the WebGL renderer its subpixel antialiasing, which is what thickens dark strokes on a light ground, so on that renderer the light theme now draws its terminal text a step heavier and a shade denser to make up the difference. Text on the DOM renderer and on the dark themes is unchanged, so light terminal text looks slightly different between the two renderers.
  ko: 라이트 터미널 글자가 유리 필드 위에서도 굵기를 지킵니다. 필드를 비우면 WebGL 렌더러가 서브픽셀 안티에일리어싱을 잃는데, 그것이 밝은 바탕에서 어두운 획을 두껍게 하던 장치입니다. 그래서 이 렌더러에서만 라이트 터미널 글자를 한 단 굵게, 한 톤 진하게 그려 차이를 메웁니다. DOM 렌더러와 다크 테마의 글자는 그대로이므로, 라이트 터미널 글자는 두 렌더러 사이에서 조금 다르게 보입니다.
- The Liquid glass switch in Settings works in the light theme again, and its help text now reads the same on every theme.
  ko: 설정의 리퀴드 글래스 손잡이를 라이트 테마에서도 다시 쓸 수 있고, 도움말도 모든 테마에서 같은 문안으로 읽힙니다.

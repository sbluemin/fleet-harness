---
branch: launch-provider-glyphs
---

### fleet-console
#### Changed
- The Claude (Gateway) launch menus now group enabled models under provider bands with the matching provider glyph and show short model names without the provider prefix. Each menu is sized to the names it carries, and a submenu always opens outward from the box that owns it instead of folding back over the menu you opened it from.
  ko: Claude (Gateway) 실행 메뉴가 이제 켠 모델을 프로바이더 밴드와 해당 글리프 아래로 묶고, 프로바이더 접두 없는 짧은 모델 이름을 보여 줍니다. 각 메뉴는 담고 있는 이름에 맞는 폭으로 서고, 서브메뉴는 언제나 자기 부모 상자 바깥쪽으로 열려 열어 온 메뉴 위로 되돌아 겹치지 않습니다.
- Reasoning effort is now a track you drag or click along, rather than a list of choices. Rungs a model does not offer keep their place on the ladder instead of being spaced out evenly, so a model that offers only low, high and max shows high where it actually sits. The first stop leaves the effort unset and launches on the model's own default.
  ko: 추론 강도를 목록 대신 끌거나 눌러 고르는 트랙으로 바꿨습니다. 모델이 내놓지 않는 단도 사다리에서 자기 자리를 지키므로, low·high·max만 있는 모델에서 high가 실제 자리에 섭니다. 맨 앞 자리는 강도를 비워 두어 모델 자체 기본값으로 실행합니다.
- Quick Launch carries the effort track beside the model chip, so the model popover only picks a model. Choosing a model that does not offer the remembered effort clears it instead of launching on a rung that model rejects.
  ko: Quick Launch는 강도 트랙을 모델 칩 옆에 두고, 모델 팝오버는 모델만 고릅니다. 기억해 둔 강도를 내놓지 않는 모델을 고르면 그 강도를 비워, 모델이 거부할 단으로 실행하지 않습니다.
- In the canvas launch menu the track only sets the value; the model row still launches, and carries the effort you chose.
  ko: 캔버스 실행 메뉴에서 트랙은 값만 정하고, 실행은 모델 행이 그대로 맡아 고른 강도를 싣습니다.
- Each Quick Launch popover opens under the chip you pressed, and the composer sends with a single round button whose esc hint reads as a hint rather than a control.
  ko: Quick Launch 팝오버는 누른 칩 아래에 열리고, 컴포저는 원형 버튼 하나로 실행하며 esc 힌트는 누를 수 있는 컨트롤이 아니라 힌트로 읽힙니다.
- The canvas effort track follows its model row while the list scrolls, and closes once that row scrolls out of view rather than sitting beside a row it no longer belongs to.
  ko: 캔버스 강도 트랙은 목록이 스크롤되는 동안 자기 모델 행을 따라가고, 그 행이 시야를 벗어나면 닫혀 더 이상 자기 것이 아닌 행 옆에 남지 않습니다.

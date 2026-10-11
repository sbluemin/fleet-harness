---
branch: feat/sidebar-theater-inbox
---

### fleet-console
#### Changed
- Autonomous operation is now a standard feature, available in every Theater without enabling an experiment.
  ko: 자율 운영을 실험 기능에서 정식 기능으로 승격하여 별도의 실험 설정 없이 모든 Theater에서 사용할 수 있습니다.
- The sidebar no longer has a separate Commodore row: each Theater's header shows the Commodore glyph (lit while the Commodore runs it, grey otherwise), and clicking the glyph turns autonomous operation on or off for that Theater.
  ko: 사이드바의 별도 사령관 줄이 없어졌습니다. Theater 머리에 사령관 글리프가 서고(사령관이 운영 중이면 밝게, 아니면 회색), 글리프를 누르면 그 Theater의 자율 운영을 바로 켜거나 끕니다.
- Clicking the current Theater's header now opens its Theater Inbox, at the Commodore log while the Commodore runs it and at the system prompt otherwise. The header's actions button is gone: its actions stay in the right-click menu, New group is also at the bottom of the header's + menu, and Forget Theater is also in the Inbox.
  ko: 지금 Theater의 머리를 누르면 Theater Inbox가 열립니다. 사령관이 운영 중이면 사령관 기록, 아니면 시스템 프롬프트가 먼저 보입니다. 머리의 「…」 단추는 없어졌고, 그 동작은 우클릭 메뉴에 그대로 있으며 「새 그룹…」은 머리 「+」 메뉴 맨 아래에, 「Theater 잊기…」는 Inbox에도 있습니다.
#### Fixed
- Theater names can be dragged in the sidebar to reorder multiple Theaters.
  ko: 사이드바에서 Theater 이름을 드래그하여 여러 Theater의 순서를 바꿀 수 있습니다.

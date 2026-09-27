---
branch: console-archive-ui
---

### fleet-console
#### Breaking Changes
- Closing an Operation now archives it instead of deleting it, whether from its caption, the sidebar, a context menu, the command palette, the mobile view, or Console Use. Undo right away from the toast or with Cmd+Z (Ctrl+Z), and open Archive at the bottom of the sidebar, or from the taskbar in Zen Mode, to restore an Operation with its conversation or delete it permanently.
  ko: 이제 캡션·사이드바·우클릭 메뉴·명령 팔레트·모바일 화면·Console Use 어디서 Operation을 닫아도 삭제되지 않고 보관됩니다. 토스트나 Cmd+Z(Ctrl+Z)로 바로 되돌릴 수 있고, 사이드바 맨 아래나 Zen Mode 작업 표시줄의 보관함에서 대화와 함께 복원하거나 영구 삭제할 수 있습니다.
- Completing an objective now archives its Operation together with its child sessions. Operations of objectives completed before this update stay open until you reopen the objective and complete it again.
  ko: 이제 목표를 완료하면 그 Operation이 자식 세션과 함께 보관됩니다. 이번 업데이트 전에 완료한 목표의 Operation은 목표 완료를 풀었다가 다시 완료할 때까지 열린 채로 남습니다.

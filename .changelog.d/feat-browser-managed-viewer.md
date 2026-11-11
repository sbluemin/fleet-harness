---
branch: feat/browser-managed-viewer
---

### fleet-console
#### Added
- Watch the managing Fleet Desktop's live Fleet Browser tabs from remote and non-managing Console screens in a read-only viewer while agents continue browsing.
  ko: 에이전트가 브라우징을 이어 가는 동안 원격 및 비관리 Console 화면에서 관리 Fleet Desktop의 실시간 Fleet Browser 탭을 보기 전용 뷰어로 확인할 수 있습니다.

### fleet-desktop
#### Changed
- Keep Fleet Browser running exclusively on the Fleet Desktop that manages each native or WSL Console so remote connections, Console switches, and control changes no longer move or close open tabs. Consoles running without a managing Fleet Desktop cannot open Fleet Browser.
  ko: 네이티브 및 WSL Console을 관리하는 Fleet Desktop에서만 Fleet Browser를 실행하여 원격 연결, Console 전환, 제어권 변경이 일어나도 열린 탭이 옮겨지거나 닫히지 않습니다. 관리 Fleet Desktop 없이 실행 중인 Console에서는 Fleet Browser를 열 수 없습니다.

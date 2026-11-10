---
branch: feat/wsl-managed-lifecycle
---

### fleet-desktop
#### Added
- On Windows, Fleet Desktop can manage the Console inside a WSL distribution. Add a distribution from "Add console", then start, stop, or restart its Console from its section in the sidebar; Desktop installs the runtime it needs in that distribution on the first start and finds the Console again after Desktop restarts. Quitting Fleet Desktop stops the WSL Consoles it manages. The first start needs `python3`, `make`, and `g++` in the distribution.
  ko: Windows의 Fleet Desktop이 WSL 배포판 안의 Console을 관리할 수 있습니다. 「콘솔 추가」에서 배포판을 추가한 뒤 사이드바의 해당 섹션에서 Console을 시작·중지·재시작할 수 있고, 필요한 런타임은 처음 시작할 때 Desktop이 그 배포판에 설치하며, Desktop을 다시 켜도 같은 Console을 다시 찾아 관리합니다. Fleet Desktop을 종료하면 관리 중인 WSL Console도 함께 종료됩니다. 처음 시작하려면 배포판에 `python3`, `make`, `g++`가 있어야 합니다.

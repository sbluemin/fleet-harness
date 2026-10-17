---
branch: fix/muse-quota-persist
---

### fleet-console
#### Fixed
- Usage limits keep the last reading when a provider reports no open window, and show it again after Console restarts until that window resets. Signing out clears the saved reading.
  ko: 공급자가 지금 열린 사용 창이 없다고 해도 사용 한도는 마지막 값을 유지하고, Console을 다시 열어도 그 창이 끝나기 전까지 같은 값을 보여 줍니다. 로그아웃하면 저장된 값은 지워집니다.

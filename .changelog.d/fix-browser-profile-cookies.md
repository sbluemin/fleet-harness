---
branch: fix/browser-profile-cookies
---

### fleet-desktop
#### Fixed
- Fleet Browser keeps cookies that should outlive a restart, so a site you stayed signed in to is still signed in after you quit Desktop and open it again.
  ko: 재시작 뒤에도 남아야 하는 Fleet Browser 쿠키가 유지되어, Desktop을 종료했다가 다시 열어도 로그인해 둔 사이트가 풀리지 않습니다.

---
branch: feat/tab-close-selection
---

### fleet-console
#### Changed
- Closing the tab you are viewing now brings up the tab that page opened, then a tab opened from the same page, then the page that opened it, and otherwise the neighboring tab instead of jumping to the end of the tab strip.
  ko: 보고 있던 탭을 닫으면 그 탭이 연 탭, 같은 페이지에서 연 탭, 그 페이지를 연 탭 순으로 띄우고, 없으면 탭줄 끝이 아니라 옆 탭으로 이동합니다.

### fleet-desktop
#### Fixed
- Tabs opened in the background with Cmd-click or middle-click, and tabs opened by an agent, no longer sometimes stay blank when you first switch to them.
  ko: Cmd·중간 클릭으로 백그라운드에 연 탭과 에이전트가 연 탭으로 처음 이동할 때 빈 화면이 남는 경우가 없어졌습니다.

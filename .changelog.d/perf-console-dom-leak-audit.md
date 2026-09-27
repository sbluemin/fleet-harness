---
branch: perf-console-dom-leak-audit
---

### fleet-console
#### Fixed
- With many Operations open, opening and closing the sidebar or docked tool panels no longer stutters, and the terminals you are looking at keep their fast renderer instead of silently falling back.
  ko: Operation을 많이 열어 두어도 사이드바나 도킹된 도구 패널을 여닫을 때 끊기지 않고, 보고 있는 터미널이 느린 렌더러로 조용히 떨어지지 않고 빠른 렌더러를 유지합니다.

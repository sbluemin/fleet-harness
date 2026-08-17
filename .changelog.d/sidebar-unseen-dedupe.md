---
branch: sidebar-unseen-dedupe
---

### fleet-console
#### Changed
- A sidebar row that finished without being opened is now told once by its activity mark, instead of being repeated as a separate dot at the row's right edge, a tinted row, and a count on the status group header.
  ko: 끝났지만 아직 열지 않은 사이드바 행을 활동 마크 하나로만 말합니다. 행 오른쪽 끝의 별도 점, 행 틴트, 상태 그룹 헤더의 카운트로 같은 사실을 되풀이하지 않습니다.

#### Fixed
- Sidebar rows outside the status sections, including the group axis and the minimized shelf, called such an operation idle while the extra dot said it had arrived. Every sidebar list now reads the same activity.
  ko: 상태 섹션 밖의 사이드바 행은 그런 Operation을 유휴라고 부르면서 옆의 점만 도착을 말했습니다. 그룹 축과 최소화 선반을 포함해 모든 사이드바 목록이 이제 같은 활동을 읽습니다.

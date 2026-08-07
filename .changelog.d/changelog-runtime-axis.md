---
branch: changelog-runtime-axis
---

### fleet-console
#### Changed
- Group release notes by the runtime a change is noticed in. What's new now shows Fleet CLI, Fleet Console, and Fleet Desktop tabs for a new release instead of splitting one feature across package-shaped tabs, and a change built in a shared package is listed under the runtime it surfaces in. Releases up to v1.51.0 keep their original grouping under tabs marked as historical, and section chips read in Korean when the Console language is Korean.
  ko: 릴리스 노트를 변경이 드러나는 런타임 기준으로 묶습니다. 새 소식의 새 릴리스는 한 기능이 패키지 단위 탭으로 쪼개지는 대신 Fleet CLI·Fleet Console·Fleet Desktop 탭으로 표시되고, 공용 패키지에서 만든 변경도 그것이 드러나는 런타임 아래에 실립니다. v1.51.0까지의 릴리스는 이전 릴리스로 표시된 탭에서 원래 분류를 그대로 유지하며, Console 언어가 한국어면 섹션 칩도 한국어로 표시됩니다.
#### Fixed
- Show release-note entries that a repeated section heading used to hide. The v1.3.0 release listed `Fixed` twice, and only the first block was read, so three fixes were missing from What's new. Entries under a heading this Console version does not recognize are now kept as well, instead of being dropped without a trace.
  ko: 반복된 섹션 제목 때문에 가려지던 릴리스 노트 항목을 표시합니다. v1.3.0 릴리스는 `Fixed`가 두 번 나왔는데 첫 블록만 읽혀 수정 3건이 새 소식에서 빠져 있었습니다. 이 Console 버전이 알지 못하는 제목 아래의 항목도 이제 흔적 없이 사라지지 않고 함께 보존됩니다.

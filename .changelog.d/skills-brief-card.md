---
branch: skills-brief-card
---

### fleet-console
#### Changed
- Installed skill cards say what a skill does. The card carries the skill's own description, the agent list collapses to a count, and a project skill that hides a global one of the same name is marked as such.
  ko: 설치된 스킬 카드가 그 스킬이 무엇을 하는지 말해 줍니다. 카드에 스킬 자신의 설명이 실리고, 에이전트 나열은 개수로 접히며, 같은 이름의 전역 스킬을 가리는 프로젝트 스킬에는 그 사실이 표시됩니다.
- The scope-wide update moves off every card into one action above the list, labeled with how many skills it will touch, and Remove is now a word instead of a bare glyph.
  ko: 스코프 전체 업데이트가 카드마다 반복되는 대신 목록 위 한 곳으로 모이고, 몇 개를 건드리는지 라벨에 적힙니다. 제거는 글리프 대신 낱말로 표시됩니다.
- The installed filter matches a skill's description, so a word that appears only there still finds the skill.
  ko: 설치된 스킬 필터가 설명까지 훑으므로, 설명에만 나오는 낱말로도 스킬을 찾을 수 있습니다.

#### Fixed
- Installed skills show which registry they came from again. The panel could only read an older skills lock file layout, so every skill was reported as having no source.
  ko: 설치된 스킬이 어느 레지스트리에서 왔는지 다시 표시됩니다. 패널이 예전 스킬 lock 파일 구조만 읽을 수 있어 모든 스킬을 출처 없음으로 표시하던 문제입니다.

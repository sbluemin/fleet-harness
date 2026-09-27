---
branch: skills-s1-s6
---

### fleet-console
#### Added
- Update a single skill from its detail view, and see which skills changed after any skill update.
  ko: 스킬 상세 창에서 스킬 하나만 업데이트할 수 있고, 업데이트 뒤 어떤 스킬이 바뀌었는지 볼 수 있습니다.

#### Changed
- Skill cards now show whether Fleet sessions load each skill, and installing asks whether the skill is for Claude Code or for the folder other coding CLIs share.
  ko: 스킬 카드에 Fleet 세션이 그 스킬을 싣는지가 표시되고, 설치할 때 Claude Code용인지 다른 코딩 CLI가 함께 쓰는 폴더용인지 고릅니다.
- Installing or updating skills from Console no longer sends usage telemetry to the skills registry.
  ko: Console에서 스킬을 설치하거나 업데이트할 때 스킬 레지스트리로 사용 통계를 보내지 않습니다.

#### Fixed
- Project skills installed for Claude Code together with other CLIs now reach Fleet sessions even when the project had no `.claude` folder.
  ko: Claude Code와 다른 CLI를 함께 골라 설치한 프로젝트 스킬이 `.claude` 폴더가 없던 프로젝트에서도 Fleet 세션에 실립니다.
- Global Claude Code skills kept in a custom `CLAUDE_CONFIG_DIR` outside your home folder now show their descriptions and open in the detail view.
  ko: 홈 폴더 밖의 `CLAUDE_CONFIG_DIR`에 둔 전역 Claude Code 스킬도 설명이 표시되고 상세 창에서 열립니다.
- Skill descriptions written as multi-line YAML blocks now appear instead of a blank line.
  ko: 여러 줄 YAML 블록으로 쓴 스킬 설명이 빈칸 대신 표시됩니다.

---
branch: theater-prompt-host
---

### fleet-console
#### Breaking Changes
- Set Claude Code system prompts separately for each Theater from its menu; the former Console-wide prompt is no longer applied or migrated, so re-enter any instructions you still need in each Theater. Console-external `fleet` CLI launches use Claude Code defaults.
  ko: Claude Code 시스템 프롬프트를 Theater 메뉴에서 Theater마다 따로 정할 수 있습니다. 기존 Console 전체 프롬프트는 적용되거나 이관되지 않으므로 필요한 지침은 각 Theater에 다시 입력해야 합니다. Console 밖 `fleet` CLI는 Claude Code 기본값으로 실행됩니다.

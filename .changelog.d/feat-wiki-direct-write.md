---
branch: feat/wiki-direct-write
---

### fleet-console
#### Changed
- Wiki changes from agents now go straight into the entry instead of waiting in a review queue. Overwritten and deleted versions are kept so they can be restored, and deleting an entry in Codex offers an immediate undo.
  ko: 에이전트가 쓴 위키 변경이 검토 대기열을 거치지 않고 바로 항목에 반영됩니다. 덮어쓰거나 지운 이전 본문은 보관되어 되살릴 수 있고, Codex에서 항목을 지우면 바로 되돌리기를 할 수 있습니다.
#### Removed
- The Codex review queue and conflict screens are gone, along with the agent tools for approving or editing pending wiki patches. Patches still pending from earlier versions are kept on disk but never applied.
  ko: Codex의 검토 대기열·충돌 화면과, 대기 중인 위키 패치를 승인하거나 고치던 에이전트 도구가 사라졌습니다. 이전 버전에서 대기 중이던 패치는 디스크에 남지만 적용되지 않습니다.

---
branch: feat/objective-aa10a06a-archive
---

### fleet-console
#### Changed
- Objectives are archived instead of deleted: the Archive button on an objective, including on mobile, and archiving from the sidebar both send it to the archive with its Operation, and restoring brings back its missions and records. The archive lists objectives only as Operations, and previously tidied objectives move there without automatic expiration.
  ko: 목표는 삭제 대신 보관됩니다. 목표의 보관 버튼(모바일 포함)이나 사이드바에서 보관하면 Operation과 함께 보관함으로 가고, 복원하면 임무·기록과 함께 돌아옵니다. 보관함은 목표를 Operation 단위로만 보여 주며, 기존 정리된 목표는 자동 만료 없이 그곳으로 옮겨집니다.
- An objective that was never started has no Operation to archive, so deleting it is permanent and asks for a second press. Newly merged objectives remain only in the receiving objective's record and cannot be restored independently.
  ko: 시작한 적 없는 목표는 보관할 Operation이 없어 삭제가 영구적이며, 한 번 더 눌러야 삭제됩니다. 새로 병합한 목표는 받은 목표의 기록에만 남고 독립적으로 복원할 수 없습니다.

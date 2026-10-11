---
branch: feat/objective-aa10a06a-archive
---

### fleet-console
#### Changed
- Archived objectives leave active lists and return with their missions and records when their Operation is restored. Previously tidied objectives move to the Operation archive without automatic expiration.
  ko: 보관한 목표는 활성 목록에서 빠지고 Operation을 복원하면 임무·기록과 함께 돌아옵니다. 기존 정리된 목표는 자동 만료 없이 Operation 보관함으로 옮겨집니다.
- Removing an objective that has no Operation now deletes it permanently. Newly merged objectives remain only in the receiving objective's record and cannot be restored independently.
  ko: Operation이 없는 목표를 제거하면 이제 영구 삭제됩니다. 새로 병합한 목표는 받은 목표의 기록에만 남고 독립적으로 복원할 수 없습니다.

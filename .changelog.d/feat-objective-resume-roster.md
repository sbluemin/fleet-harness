---
branch: feat/objective-resume-roster
---

### fleet-console
#### Changed
- Objectives that were in progress now pick up on their own after Console restarts, so the Commodore no longer wakes just because Console restarted; it wakes only for an objective that could not resume.
  ko: 진행 중이던 목표는 이제 Console이 다시 시작된 뒤 스스로 이어지므로, 사령관은 재시작만으로 깨어나지 않고 이어가지 못한 목표가 있을 때만 깨어납니다.
- Commencing an objective starts only the members that have a mission, and the Commander can release a member that has none.
  ko: 목표를 개시하면 임무를 맡은 구성원만 세워지고, 지휘관은 맡은 일이 없는 구성원을 명단에서 뺄 수 있습니다.
- Extending an objective now starts the new round as soon as its success criteria are settled, without a separate commence.
  ko: 목표를 확장하면 이제 성공 기준이 정리되는 대로 따로 개시하지 않아도 새 회차가 시작됩니다.

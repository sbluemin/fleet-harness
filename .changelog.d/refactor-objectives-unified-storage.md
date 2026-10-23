---
branch: refactor/objectives-unified-storage
---

### fleet-console
#### Breaking Changes
- Unify conversations and their boards as Objectives, keeping their sessions, groups, archives, and shared files under their Commodore. Console Use session control is now `console_objective_session`; integrations must use the Objective API and event names.
  ko: 대화와 보드를 목표로 통합하고, 세션·그룹·보관 기록·공유 파일을 사령관 아래에 함께 보관합니다. Console Use 세션 제어는 이제 `console_objective_session`이며, 외부 연동은 목표 기준 API와 이벤트 이름으로 바꿔야 합니다.

### fleet-desktop
#### Breaking Changes
- Update Fleet Desktop together with Console to keep embedded browser views recognized on the new Objective event stream.
  ko: 새 목표 이벤트 스트림에서도 내장 브라우저 뷰가 올바르게 인식되도록 Console과 Fleet Desktop을 함께 업데이트해야 합니다.

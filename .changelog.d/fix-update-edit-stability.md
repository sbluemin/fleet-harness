---
branch: fix/update-edit-stability
---

### fleet-console
#### Fixed
- A Theater system prompt longer than 16,000 characters is no longer lost when you close its sheet; the draft stays in the tab until you shorten, copy or discard it.
  ko: 16,000자를 넘긴 Theater 시스템 프롬프트를 시트를 닫아도 잃지 않습니다. 줄이거나 복사하거나 버릴 때까지 초안이 이 탭에 남습니다.
- Picking a member setting that is already active in Objectives no longer clears the Commander's pending decision request.
  ko: Objectives에서 이미 적용된 구성원 설정을 다시 골라도 지휘관의 대기 중인 결정 요청이 사라지지 않습니다.
- The update screen no longer says it is installing while it is stopping the Console or reconnecting.
  ko: 업데이트 화면이 Console을 멈추거나 다시 연결하는 동안 설치 중이라고 말하지 않습니다.

### fleet-desktop
#### Fixed
- Applying a Console update from several tabs at once restarts the app only once; the other tabs are told an update is already in progress.
  ko: 여러 탭에서 동시에 Console 업데이트를 적용해도 앱은 한 번만 다시 시작하고, 나머지 탭에는 이미 업데이트가 진행 중이라고 알립니다.

---
branch: feat/desktop-lock-conflict-dialog
---

### fleet-desktop
#### Changed
- When another Fleet Console blocks Desktop from starting, the dialog now says what is holding it (still starting, shutting down, not responding, or unidentified) with its process ID and lock file, and how to clear it, instead of always saying Fleet Console is already running.
  ko: 다른 Fleet Console 때문에 Desktop을 시작할 수 없을 때, 항상 "이미 실행 중"이라고만 하던 대화상자가 이제 무엇이 막고 있는지(시작 중, 종료 중, 응답 없음, 확인되지 않은 프로세스)를 프로세스 ID·lock 파일과 함께 알려 주고 해결 방법을 안내합니다.

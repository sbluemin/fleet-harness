---
branch: repository-flicker-fix
---

### fleet-console
#### Fixed
- Repository panel no longer flickers on refresh, sync, staging, branch selection, or commit navigation: the branch tree, history list, changed-file count, and inspector keep the current content on screen until the new data arrives, and only the refresh glyph spins while a reload is in flight.
  ko: Repository 패널이 새로고침·동기화·스테이징·브랜치 선택·커밋 이동 때 깜빡이지 않습니다. 브랜치 트리, 기록 목록, 변경 파일 수, 검사기는 새 데이터가 올 때까지 현재 내용을 그대로 유지하고, 다시 읽는 동안에는 새로고침 글리프만 돕니다.

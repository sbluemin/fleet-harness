---
branch: fix/session-transcript-isolation
---

### fleet-console
#### Fixed
- Keep sessions isolated when a saved transcript file is missing so Console never attaches another session's history or ID from the same folder.
  ko: 저장된 세션 기록 파일이 없을 때 같은 폴더의 다른 세션 기록이나 세션 ID를 대신 연결하지 않도록 세션 격리를 유지합니다.

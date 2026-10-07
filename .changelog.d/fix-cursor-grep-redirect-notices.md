---
branch: fix/cursor-grep-redirect-notices
---

### fleet-console
#### Fixed
- Cursor models searching files no longer receive Claude Code's summary lines, such as "Found 3 files" or "No files found", as file names, and no longer lose real files whose names start with `[` or "No matches".
  ko: Cursor 모델이 파일을 검색할 때 「Found 3 files」나 「No files found」 같은 Claude Code 요약 문구를 파일 이름으로 받지 않고, 이름이 `[`나 「No matches」로 시작하는 실제 파일을 잃지 않습니다.

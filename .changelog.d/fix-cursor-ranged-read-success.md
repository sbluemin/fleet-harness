---
branch: fix/cursor-ranged-read-success
---

### fleet-console
#### Fixed
- Cursor models reading only part of a file now get the requested lines on the first try instead of a refusal and a retry, so replies arrive sooner and use less of your allowance; very long files still need a second read.
  ko: Cursor 모델이 파일의 일부만 읽을 때 거절과 재시도 없이 첫 시도에 요청한 줄을 받아 응답이 더 빨라지고 사용 한도도 덜 씁니다. 아주 긴 파일은 여전히 한 번 더 읽어야 합니다.

---
branch: fix/cursor-native-glob
---

### fleet-console
#### Fixed
- Cursor models now get real results from their own file-name search instead of an empty answer and a request to retry, and run shell commands on the first try instead of first looking up a shell tool, so replies arrive sooner and use less of your allowance.
  ko: Cursor 모델이 자체 파일 이름 검색을 쓰면 빈 결과와 재시도 요청 대신 실제 결과를 받고, 셸 명령은 셸 도구를 먼저 찾지 않고 첫 시도에 실행되어 응답이 더 빨라지고 사용 한도도 덜 씁니다.

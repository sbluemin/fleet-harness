---
branch: cursor-composer-compaction
---

### fleet-cli
#### Fixed
- Let Cursor models page through the caller Read tool instead of repeatedly replaying whole files through failed native reads, reducing context growth and compaction during long gateway sessions.
  ko: Cursor 모델이 실패한 네이티브 읽기로 전체 파일을 반복 재전송하는 대신 호출자 Read 도구로 페이지를 나눠 읽게 하여 장기 게이트웨이 세션의 컨텍스트 증가와 컴팩션을 줄였습니다.

### fleet-console
#### Fixed
- Let Cursor models page through the caller Read tool instead of repeatedly replaying whole files through failed native reads, reducing context growth and compaction during long gateway Operations.
  ko: Cursor 모델이 실패한 네이티브 읽기로 전체 파일을 반복 재전송하는 대신 호출자 Read 도구로 페이지를 나눠 읽게 하여 장기 게이트웨이 Operation의 컨텍스트 증가와 컴팩션을 줄였습니다.

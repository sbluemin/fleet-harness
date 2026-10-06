---
branch: fix/cursor-grep-plaintext
---

### fleet-console
#### Fixed
- Cursor code search that runs through a shell tool now shows the ripgrep command and the matching lines in the chat, instead of an unreadable encoded blob. A search that is cut off is marked incomplete rather than reported as the whole result.
  ko: 셸 도구로 실행되는 Cursor 코드 검색이 채팅에 읽을 수 없는 인코딩 덩어리 대신 ripgrep 명령과 일치한 줄을 보여 줍니다. 잘린 검색은 전체 결과가 아니라 불완전한 결과로 표시됩니다.

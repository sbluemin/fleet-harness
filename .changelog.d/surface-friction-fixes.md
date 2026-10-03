---
branch: surface-friction-fixes
---

### fleet-console
#### Fixed
- File content search works again on Node 22.0 through 22.11, and a folder you cannot read no longer makes the whole search fail; results show how many paths were skipped.
  ko: Node 22.0~22.11에서도 파일 내용 검색이 다시 동작하고, 읽을 수 없는 폴더가 있어도 검색 전체가 실패하지 않으며 건너뛴 경로 수를 알려 줍니다.
- Approving an outdated wiki proposal now explains which version it was written against instead of failing with a server error, and repeated attempts or failed Cowork applies no longer leave extra conflicts or stray proposals behind.
  ko: 오래된 위키 제안을 승인하면 서버 오류 대신 어느 버전 기준인지 안내하고, 다시 시도하거나 Cowork 적용이 실패해도 충돌이나 남는 제안이 쌓이지 않습니다.
- Markdown previews no longer cut off the right edge of the text; only wide code blocks and tables scroll sideways.
  ko: Markdown 미리보기에서 본문 오른쪽이 잘리지 않고, 넓은 코드 블록과 표만 가로로 스크롤됩니다.
- The Shell close button responds across its whole area, and gray terminal output in dark themes is readable.
  ko: Shell 닫기 버튼이 전체 영역에서 눌리고, 다크 테마의 회색 터미널 출력이 잘 읽힙니다.

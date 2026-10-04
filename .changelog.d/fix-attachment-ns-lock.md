---
branch: fix/attachment-ns-lock
---

### fleet-console
#### Fixed
- Starting a second Console on the same data folder while one is already running no longer deletes the images attached to that running Console's sessions and drafts.
  ko: 이미 실행 중인 Console과 같은 데이터 폴더로 Console을 한 번 더 띄워도, 실행 중인 Console의 세션과 작성 중인 입력에 첨부한 이미지가 더 이상 지워지지 않습니다.

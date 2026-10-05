---
branch: feat/update-curtain-failure
---

### fleet-console
#### Changed
- When an in-place Console update fails, the update screen now says why and how the previous Console ended, instead of only an error code.
  ko: Console 제자리 업데이트가 실패하면 업데이트 화면이 오류 코드만 보여 주는 대신 실패 원인과 이전 Console이 어떻게 종료됐는지 알려 줍니다.
- If no Console answers well after an update should have brought one back, the update screen shows `fleet console start` to recover by hand, rather than waiting ten minutes and then clearing without a word.
  ko: 업데이트 뒤 Console이 돌아와야 할 시간이 한참 지나도 응답이 없으면, 10분을 기다렸다가 말없이 사라지는 대신 직접 복구할 수 있도록 `fleet console start`를 안내합니다.

---
branch: fix/commodore-theater-path-identity
---

### fleet-console
#### Fixed
- Opening a Theater's Commodore chat after updating from an older Console no longer hangs on "Loading conversation" or fails to save with `theater_unavailable`, and a Theater whose path differs only in letter case or separators stays with the same Commodore.
  ko: 이전 버전에서 업데이트한 뒤 Theater의 사령관 대화를 열어도 "대화를 불러오는 중"에 멈추거나 `theater_unavailable`로 저장에 실패하지 않습니다. 경로가 대소문자나 구분자만 다른 Theater도 같은 사령관에 남습니다.

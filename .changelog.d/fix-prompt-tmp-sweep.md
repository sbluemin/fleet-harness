---
branch: fix/prompt-tmp-sweep
---

### fleet-console
#### Fixed
- Temporary copies of a Theater's system prompt no longer pile up in the temp folder after Console is force-quit or crashes; the next start removes them. Copies left by versions before this fix are not removed automatically.
  ko: Console이 강제 종료되거나 비정상 종료된 뒤에도 Theater 시스템 프롬프트의 임시 사본이 temp 폴더에 쌓이지 않고 다음 기동 때 지워집니다. 이 수정 이전 버전이 남긴 사본은 자동으로 지워지지 않습니다.

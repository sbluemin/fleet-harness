---
branch: fix/update-worker-sigkill
---

### fleet-console
#### Fixed
- Applying a Console update no longer risks quitting an unrelated program that happened to reuse the previous Console's process ID; if the previous Console cannot be confirmed and does not shut down, the update now fails and tells you to quit it yourself instead of force-quitting it.
  ko: Console 업데이트를 적용할 때 이전 Console의 프로세스 ID를 이어받은 무관한 프로그램이 종료될 위험이 사라졌습니다. 이전 Console이 종료되지 않고 같은 프로세스인지 확인할 수 없으면 강제로 종료하지 않고, 직접 종료하라는 안내와 함께 업데이트가 실패합니다.

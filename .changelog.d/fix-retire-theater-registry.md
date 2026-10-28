---
branch: fix/retire-theater-registry
---

### fleet-console
#### Breaking Changes
- Retire the Console-wide Theater registration APIs. Integrations must use the owning Commodore's folder APIs; existing Objectives keep their working folders.
  ko: Console 전역 Theater 등록 API를 퇴역합니다. 연동은 소유 사령관의 폴더 API로 전환해야 하며, 기존 목표의 작업 폴더는 유지됩니다.

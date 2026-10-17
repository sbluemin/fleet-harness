---
branch: fix/capture-identity-diagnostics
---

### fleet-console
#### Fixed
- When Computer Use screen sharing cannot identify the window because Fleet lacks macOS Accessibility permission, the preview now says so and offers a button to request that permission, instead of a generic message that also pointed at Screen Recording.
  ko: Computer Use 화면공유가 macOS 손쉬운 사용 권한이 없어 창을 식별하지 못하면, 미리보기가 화면 기록 권한까지 함께 언급하던 일반 문구 대신 그 이유를 알리고 권한을 요청하는 버튼을 보여 줍니다.

---
branch: fix/native-modal-lock
---

### fleet-desktop
#### Fixed
- Keep Fleet Desktop and its Fleet Browser clickable while a page's passkey or Windows Hello prompt, file picker, or download dialog is open on Windows, so the window no longer locks up on sign-in pages that start a passkey request. Passkey requests are no longer blocked from sites that probe for autofill.
  ko: Windows에서 페이지가 띄운 패스키·Windows Hello 확인, 파일 선택, 다운로드 대화상자가 열려 있어도 Fleet Desktop과 플랫폼 브라우저를 계속 클릭할 수 있습니다. 패스키 요청을 시작하는 로그인 페이지에서 창이 잠기던 문제가 사라지고, 자동 완성을 확인하는 사이트의 패스키 요청도 더 이상 막지 않습니다.

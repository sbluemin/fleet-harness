---
branch: claude-login-flow
---

### fleet-console
#### Added
- Sign in to Claude from the usage panel with one Sign in button: it picks up your existing terminal `claude` login, or opens a sign-in card with a code field for the code the sign-in page shows.
  ko: 사용량 패널에서 '로그인' 단추 하나로 Claude에 로그인합니다. 터미널 `claude`의 기존 로그인이 있으면 그대로 쓰고, 없으면 로그인 카드가 열려 로그인 페이지에 뜬 코드를 붙여 넣을 수 있습니다.
- The Commodore and Commander chats now show when the Claude Code CLI is missing or signed out, block sending until it is ready, and keep your draft.
  ko: 사령관과 지휘관 채팅이 Claude Code CLI가 없거나 로그인되지 않은 상태를 알리고, 준비될 때까지 보내기를 막으며 초안을 남깁니다.
- When a message cannot be processed for that reason, the chat shows the cause with install or sign-in steps and no longer retries on its own.
  ko: 그 이유로 메시지를 처리하지 못하면 채팅이 설치·로그인 방법과 함께 원인을 보여 주고, 저절로 다시 시도하지 않습니다.

#### Changed
- Claude's usage connection no longer needs a separate "connect" step or a trip to the terminal to sign in again after it expires.
  ko: Claude 사용량 연결에 별도의 '연결' 단계가 없어지고, 만료된 뒤에도 터미널로 가지 않고 다시 로그인할 수 있습니다.

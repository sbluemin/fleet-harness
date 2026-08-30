---
branch: harness-settings-optin
---

### fleet-cli
#### Changed
- `fleet` now launches Claude Code with its permission prompts intact. Turn on "Skip permission prompts" in Fleet Console Settings, under Harness, to launch without them as before.
  ko: `fleet`는 이제 Claude Code의 승인 프롬프트를 살린 채 실행합니다. 이전처럼 건너뛰려면 Fleet Console 설정의 하네스 항목에서 "승인 프롬프트 건너뛰기"를 켜세요.

### fleet-console
#### Added
- A Harness section in Settings gathers how agents are launched: a Claude Code card holding the permission opt-in and the system prompt switch, shared agent session settings, and the agent CLI executable list.
  ko: 설정에 하네스 항목이 생겨 에이전트를 어떻게 실행하는지가 한곳에 모입니다. 승인 옵트인과 시스템 프롬프트를 담은 Claude Code 카드, 하네스 공통 세션 설정, 에이전트 CLI 실행 파일 목록이 함께 놓입니다.
- "Skip permission prompts" is a new opt-in that is off by default. While it is off, Claude Code asks in the terminal before it edits a file, runs a command, or reaches the network. The card states where the choice applies: the terminal and the `fleet` launcher, never Chat, which has no approval screen of its own and always runs bypassed.
  ko: "승인 프롬프트 건너뛰기"는 기본이 꺼짐인 새 옵트인입니다. 꺼 두면 Claude Code가 파일을 고치거나 명령을 실행하거나 네트워크에 나가기 전에 터미널에서 묻습니다. 카드가 적용 범위를 함께 말합니다: 터미널과 `fleet` 런처에 적용되고, 자체 승인 화면이 없는 채팅은 언제나 바이패스로 실행됩니다.

#### Changed
- New Claude Code sessions no longer skip permission prompts by default. Turn the opt-in on under Settings, Harness to get the previous behavior back.
  ko: 새 Claude Code 세션은 더 이상 기본으로 승인 프롬프트를 건너뛰지 않습니다. 이전 동작이 필요하면 설정의 하네스 항목에서 옵트인을 켜세요.
- The Terminal settings section now holds only what it draws: terminal font, chat reading width, and rendering. The Claude Code system prompt and idle agent session settings moved to Harness, and the agent CLI executable list moved there from AI Gateway.
  ko: 터미널 설정 항목에는 이제 그리는 것만 남습니다. 터미널 글꼴, 채팅 읽기 폭, 그리기입니다. Claude Code 시스템 프롬프트와 유휴 에이전트 세션 설정은 하네스로 옮겼고, 에이전트 CLI 실행 파일 목록도 AI Gateway에서 하네스로 옮겼습니다.

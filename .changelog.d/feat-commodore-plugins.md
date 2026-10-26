---
branch: feat/commodore-plugins
---

### fleet-console
#### Added
- Settings now has a Marketplaces section with Anthropic's Claude Code plugin marketplaces built in, and you can add your own marketplace from a GitHub repository, a git address (https or ssh) or a marketplace.json URL.
  ko: 설정에 「마켓플레이스」가 생겨 Anthropic의 Claude Code 플러그인 마켓플레이스들이 기본으로 들어 있고, GitHub 저장소·git 주소(https·ssh)·marketplace.json 주소로 직접 마켓플레이스를 추가할 수 있습니다.
- Each Commodore can install plugins from those marketplaces in its settings; they load from its next turn and in the Commanders and members of its objectives, and a plugin that runs commands asks for your confirmation first.
  ko: 사령관마다 설정에서 그 마켓플레이스의 플러그인을 설치할 수 있습니다. 설치한 플러그인은 사령관의 다음 턴부터, 그리고 그 사령관 목표의 지휘관·구성원 세션에 실리며, 명령을 실행하는 플러그인은 먼저 확인을 받습니다.

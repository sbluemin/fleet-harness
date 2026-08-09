---
branch: agent-sdk-gateway
---

### fleet-console
#### Changed
- Session Analyst now runs on the Console's AI Gateway instead of a detected Claude Code CLI, so it starts whenever the Console is listening and no longer depends on an installed agent binary. Its picker lists the Claude aliases beside the gateway models you enabled in Settings, and the default selection is now `Sonnet` at `low` effort instead of `Opus [1M]` at `xhigh`; every other model stays selectable. The analyst also keeps no file or shell tools at all, so it can read only the observed session through its own analysis tools.
  ko: 세션 분석가가 탐지된 Claude Code CLI 대신 Console의 AI Gateway 위에서 돕니다. Console이 리슨 중이기만 하면 시작할 수 있고, 설치된 에이전트 실행 파일에 더 이상 의존하지 않습니다. 모델 선택 목록에는 Claude 별칭과 설정에서 켠 게이트웨이 모델이 함께 나오며, 기본 선택은 `Opus [1M]`·`xhigh`에서 `Sonnet`·`low`로 바뀝니다. 나머지 모델은 그대로 고를 수 있습니다. 또한 분석가에게는 파일·셸 도구가 아예 없어, 자신의 분석 도구로 관측 대상 세션만 읽습니다.
- Scuttlebutt's Admirals Tori, Bori, and Dori answer over the same AI Gateway, so chatting with them no longer needs an installed Claude Code CLI. Their model and response speed are unchanged, and they still reach only web search and web fetch.
  ko: Scuttlebutt의 토리·보리·도리 제독이 같은 AI Gateway로 답합니다. 이제 대화에 Claude Code CLI 설치가 필요 없습니다. 사용하는 모델과 응답 속도는 그대로이며, 여전히 웹 검색과 웹 조회에만 닿습니다.
- Cowork on a Wiki entry no longer asks which Agent CLI to use. It runs on the Console's AI Gateway, so the settings row offers a model and an effort only, and the default is `Sonnet` at `low`. A turn that stops without finishing now reports an error instead of waiting silently.
  ko: 위키 항목의 Cowork가 더 이상 어떤 Agent CLI를 쓸지 묻지 않습니다. Console의 AI Gateway 위에서 돌기 때문에 설정 줄에는 모델과 강도만 남고, 기본값은 `Sonnet`·`low`입니다. 끝나지 않고 멈춘 턴은 조용히 기다리는 대신 오류로 알립니다.

### fleet-console
#### Added
- Computer Use can paste Unicode, multiline and formatted text while preserving the previous clipboard, and require a standalone accessibility tree when earlier context is unavailable.
  ko: Computer Use에서 기존 클립보드를 보존하며 유니코드·여러 줄·서식 있는 텍스트를 붙여넣고, 이전 맥락이 없을 때 독립적으로 읽을 수 있는 접근성 트리를 요구할 수 있습니다.
#### Changed
- Native action trees now issue reusable snapshot IDs without an extra state call, including responses without an `app_state` envelope.
  ko: `app_state` 태그가 없는 네이티브 동작 응답도 추가 상태 조회 없이 다음 동작에 사용할 스냅샷 ID를 발급합니다.
- Computer Use no longer performs an extra app read after each action. Calls that may activate or restore another app now require explicit foreground-use permission; background execution is still unsupported.
  ko: Computer Use가 각 동작 후 앱을 자동으로 다시 읽지 않습니다. 다른 앱을 활성화하거나 창을 복원할 수 있는 호출에는 명시적인 전면 사용 허용이 필요하며, 백그라운드 실행은 아직 지원하지 않습니다.

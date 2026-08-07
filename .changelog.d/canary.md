### fleet-cli
#### Fixed
- A session launched on an OpenCode Go model through the AI Gateway no longer fails a tool call when the model invents an argument the tool never declared. Keys the tool's own schema does not list are dropped from the arguments that backend returns, because it accepts `strict: true` and then ignores it.
  ko: AI Gateway를 통해 OpenCode Go 모델로 실행한 세션에서, 모델이 도구가 선언하지 않은 인자를 지어내도 도구 호출이 실패하지 않습니다. 이 백엔드는 `strict: true`를 받아들이고도 무시하므로, 반환된 인자에서 도구 스키마에 없는 키를 제거합니다.

### fleet-console
#### Fixed
- A Claude (Gateway) Operation on an OpenCode Go model no longer fails a tool call when the model invents an argument the tool never declared. Keys the tool's own schema does not list are dropped from the arguments that backend returns, because it accepts `strict: true` and then ignores it.
  ko: OpenCode Go 모델로 실행한 Claude (Gateway) Operation에서, 모델이 도구가 선언하지 않은 인자를 지어내도 도구 호출이 실패하지 않습니다. 이 백엔드는 `strict: true`를 받아들이고도 무시하므로, 반환된 인자에서 도구 스키마에 없는 키를 제거합니다.

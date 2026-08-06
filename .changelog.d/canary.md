### fleet-console

#### Fixed

- [fleet-console] Reuse a plugin's compiled route bundle across Console server starts within one process, keyed by bundle content, instead of writing it to a fresh temporary directory and registering a separate module copy on every start.
  ko: 한 프로세스 안에서 Console 서버를 다시 시작할 때 플러그인의 컴파일된 라우트 번들을 매번 새 임시 디렉터리에 쓰고 별도 모듈 사본으로 등록하는 대신, 번들 내용을 기준으로 재사용합니다.

### fleet-plugin

#### Fixed

- [fleet-console] Hide the tool status line in a carrier stream's activity card when the running tool reports no status, instead of leaving the literal `{status}` placeholder on screen.
  ko: 캐리어 스트림 활동 카드에서 실행 중인 도구가 상태를 보고하지 않을 때 `{status}` 자리표시자를 그대로 남기는 대신 도구 상태 줄을 감춥니다.

---
branch: fleet-console-use-mcp
---

### fleet-console
#### Added
- Provide Theater, Operation, and gateway model tools through `fleet-console-use`; plugin agents can attach this host MCP alongside their own tools.
  ko: `fleet-console-use`로 Theater, Operation, Gateway 모델 도구를 제공하며 플러그인 에이전트는 자체 도구와 함께 이 호스트 MCP를 연결할 수 있습니다.

### fleet-cli
#### Changed
- Separate Wiki tools into `fleet-core` and gateway model discovery into `fleet-console-use`, without requiring a running Console.
  ko: 실행 중인 Console 없이도 Wiki 도구는 `fleet-core`, Gateway 모델 조회는 `fleet-console-use`로 분리해 제공합니다.

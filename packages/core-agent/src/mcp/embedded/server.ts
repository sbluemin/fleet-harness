import type {
  ClaudeGatewayMcpServer,
  ClaudeGatewayMcpServerOptions,
  ClaudeGatewayTool,
  ClaudeGatewayToolExtras,
  ClaudeGatewayToolResult,
} from "../../claude/contracts.js";
import { createVendorMcpServer, defineVendorTool } from "../../claude/vendor-sdk.js";

/**
 * 자식이 부를 수 있는 in-process 도구를 정의한다.
 *
 * 이름을 vendor와 똑같이 (`tool`) 두지 않는 이유는 자동완성이다. 소비처가 `tool`을 치면 vendor
 * 패키지가 함께 뜨고, 잘못 고르면 이 패키지가 막으려는 직접 의존이 생긴다. 게이트가 그걸 잡긴
 * 하지만, 부르지 않는 편이 낫다.
 *
 * `inputSchema`는 zod 3/4 raw shape다. vendor는 zod 객체의 모듈 인스턴스 동일성을 요구하지 않고
 * 형태(`parse`/`safeParse`/`_def`/`_zod`)로 판정하므로, 소비처가 자기 zod를 그대로 넘기면 된다.
 * 그래서 이 패키지는 zod를 런타임 의존으로 갖지 않는다.
 */
export function defineTool<TInput extends Record<string, unknown>>(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  handler: (args: TInput, extra: unknown) => Promise<ClaudeGatewayToolResult>,
  extras?: ClaudeGatewayToolExtras,
): ClaudeGatewayTool {
  return defineVendorTool<TInput>(name, description, inputSchema, handler, extras);
}

/** 위 도구들을 담아 턴의 `mcpServers`에 실을 in-process MCP 서버를 만든다. */
export function createEmbeddedMcpServer(options: ClaudeGatewayMcpServerOptions): ClaudeGatewayMcpServer {
  return createVendorMcpServer({
    name: options.name,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    ...(options.alwaysLoad === undefined ? {} : { alwaysLoad: options.alwaysLoad }),
  });
}

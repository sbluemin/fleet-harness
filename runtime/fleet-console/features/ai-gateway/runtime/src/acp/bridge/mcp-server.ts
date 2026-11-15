import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { wireLog } from "../../transport/wire-log.js";

/**
 * 브리지의 루프백 MCP 서버. agy가 이 서버로 Claude Code의 도구를 본다.
 *
 * 루프백(127.0.0.1) 전용 리스너를 따로 둔다 — Console HTTP 서버는 원격에서 닿을 수 있고, 이 경로는 보류 중인
 * 도구 호출에 결과를 주입하는 권한이기 때문이다. 세션마다 256비트 Bearer가 있고 경로에 세션 키가 들어간다.
 *
 * `tools/call`은 결과가 올 때까지 응답을 붙잡아 둔다(agy 기본 한도 180초, 브리지는 설정으로 늘린다). agy가 호출을
 * 취소(`notifications/cancelled`)하거나 연결을 닫으면 호출은 `abandoned`가 되고, 그 뒤 도착하는 결과는 버려진다.
 */

export interface BridgeToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export type McpResultContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface McpToolOutcome {
  readonly content: readonly McpResultContent[];
  readonly isError: boolean;
}

/** agy가 건 도구 호출 하나. 결과를 `settle`로 주기 전까지 HTTP 응답이 열려 있다. */
export interface PendingMcpCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly state: () => "pending" | "settled" | "abandoned";
  settle(outcome: McpToolOutcome): void;
}

export interface McpSessionHandler {
  tools(): readonly BridgeToolDef[];
  onCall(call: PendingMcpCall): void;
  /** agy가 결과를 기다리다 호출을 취소했거나 연결이 끊겼다. */
  onAbandon(call: PendingMcpCall, reason: string): void;
}

interface Registration {
  readonly token: Buffer;
  readonly handler: McpSessionHandler;
  readonly calls: Map<string, { readonly abandon: (reason: string) => void }>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const FALLBACK_PROTOCOL = "2025-03-26";

/** agy가 도구 인자에 끼워 넣는 설명 필드(실측). Claude Code 도구의 입력이 아니다. */
const AGY_INJECTED_ARGUMENT = "toolSummary";

function jsonBody(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    size += part.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class BridgeMcpServer {
  private readonly registrations = new Map<string, Registration>();
  private server: http.Server | undefined;
  private starting: Promise<number> | undefined;

  /** 세션을 등록하고 agy가 붙을 URL과 Bearer를 돌려준다. 리스너는 첫 등록 때 연다. */
  async register(sessionKey: string, handler: McpSessionHandler): Promise<{ readonly url: string; readonly token: string }> {
    const port = await this.listen();
    const token = randomBytes(32).toString("hex");
    this.registrations.set(sessionKey, { token: Buffer.from(token), handler, calls: new Map() });
    return { url: `http://127.0.0.1:${port}/mcp/${sessionKey}`, token };
  }

  unregister(sessionKey: string): void {
    this.registrations.delete(sessionKey);
  }

  async close(): Promise<void> {
    this.registrations.clear();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private listen(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => { void this.handle(req, res); });
      // 도구 호출 하나가 분 단위로 열려 있다. 소켓·요청 타임아웃으로 끊지 않는다.
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      server.keepAliveTimeout = 0;
      server.timeout = 0;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.starting;
  }

  private authorize(req: http.IncomingMessage, registration: Registration): boolean {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const presented = Buffer.from(header.slice("Bearer ".length));
    return presented.length === registration.token.length && timingSafeEqual(presented, registration.token);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const match = /^\/mcp\/([A-Za-z0-9._-]+)$/.exec(req.url?.split("?")[0] ?? "");
    const registration = match ? this.registrations.get(match[1]!) : undefined;
    if (req.method !== "POST") {
      // 서버가 먼저 보낼 알림이 없어 SSE 스트림을 제공하지 않는다(agy의 GET은 이 응답으로 충분하다).
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    if (!registration) { res.writeHead(404).end(); return; }
    if (!this.authorize(req, registration)) { res.writeHead(401).end(); return; }
    const raw = await readBody(req);
    let message: Record<string, unknown> | undefined;
    try { message = raw === undefined ? undefined : record(JSON.parse(raw)); } catch { message = undefined; }
    if (!message) { res.writeHead(400).end(); return; }

    const method = typeof message.method === "string" ? message.method : undefined;
    const id = message.id;
    if (method === undefined || id === undefined || id === null) {
      wireLog("bridge.mcp_notification", { session: match?.[1], method });
      if (method === "notifications/cancelled") this.cancelled(registration, record(message.params));
      res.writeHead(202).end();
      return;
    }
    wireLog("bridge.mcp", { session: match?.[1], method });
    const reply = (result: unknown): void => jsonBody(res, 200, { jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): void => jsonBody(res, 200, { jsonrpc: "2.0", id, error: { code, message: text } });
    const params = record(message.params);

    switch (method) {
      case "initialize":
        reply({
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "fleet-bridge", version: "1" },
        });
        return;
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: registration.handler.tools().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
        return;
      case "resources/list":
        reply({ resources: [] });
        return;
      case "resources/templates/list":
        reply({ resourceTemplates: [] });
        return;
      case "prompts/list":
        reply({ prompts: [] });
        return;
      case "resources/read":
        fail(-32002, "Resource not found.");
        return;
      case "tools/call":
        this.call(registration, id, params, req, res);
        return;
      default:
        fail(-32601, `Method not found: ${method}`);
    }
  }

  private call(
    registration: Registration,
    rpcId: unknown,
    params: Record<string, unknown> | undefined,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const name = typeof params?.name === "string" ? params.name : "";
    const known = registration.handler.tools().some((tool) => tool.name === name);
    const callKey = String(rpcId);
    const failure = (text: string): void => jsonBody(res, 200, {
      jsonrpc: "2.0",
      id: rpcId,
      result: { content: [{ type: "text", text }], isError: true },
    });
    if (!known) { failure(`Unknown tool: ${name}`); return; }
    const rawArgs = record(params?.arguments) ?? {};
    const { [AGY_INJECTED_ARGUMENT]: _summary, ...args } = rawArgs;
    let state: "pending" | "settled" | "abandoned" = "pending";
    const call: PendingMcpCall = {
      name,
      args,
      state: () => state,
      settle: (outcome) => {
        if (state !== "pending") return;
        state = "settled";
        wireLog("bridge.mcp_result", { name, isError: outcome.isError, parts: outcome.content.length, written: !res.writableEnded && !res.destroyed });
        registration.calls.delete(callKey);
        jsonBody(res, 200, { jsonrpc: "2.0", id: rpcId, result: { content: outcome.content, ...(outcome.isError ? { isError: true } : {}) } });
      },
    };
    const abandon = (reason: string): void => {
      if (state !== "pending") return;
      state = "abandoned";
      registration.calls.delete(callKey);
      registration.handler.onAbandon(call, reason);
    };
    // 응답을 쓰기 전에 연결이 닫히면 agy가 기다림을 포기한 것이다(한도 초과의 `context deadline exceeded` 포함).
    res.once("close", () => abandon("connection closed"));
    req.once("error", () => abandon("request error"));
    registration.calls.set(callKey, { abandon });
    registration.handler.onCall(call);
  }

  private cancelled(registration: Registration, params: Record<string, unknown> | undefined): void {
    const requestId = params?.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    registration.calls.get(String(requestId))?.abandon(typeof params?.reason === "string" ? params.reason : "cancelled");
  }
}

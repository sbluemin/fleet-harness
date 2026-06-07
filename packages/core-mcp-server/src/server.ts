import crypto from "node:crypto";
import http from "node:http";

import {
  createMcpToolSnapshotStore,
  type McpToolSnapshotStore,
} from "./tool-snapshot.js";
import type { McpToolRegistry } from "./tool-registry.js";
import type { McpCallToolResult } from "./types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingToolCall {
  toolName: string;
  toolCallId: string;
  resolve: (result: JsonRpcResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
  response?: http.ServerResponse;
  onResponseClose?: () => void;
}

interface PendingToolResult {
  toolCallId: string;
  result: McpCallToolResult;
}

export type ToolCallArrivedCallback = (
  toolName: string,
  args: Record<string, unknown>,
) => string;

export interface McpServer {
  start(): Promise<string>;
  stop(): Promise<void>;
  setOnToolCallArrived(token: string, cb: ToolCallArrivedCallback | null): void;
  resolveNextToolCall(
    token: string,
    toolCallId: string,
    result: McpCallToolResult,
  ): void;
  hasPendingToolCall(token: string): boolean;
  clearPendingForSession(token: string): void;
}

export interface CreateMcpServerDeps {
  registry: McpToolRegistry;
  serverInfo?: McpServerInfo;
  toolSnapshotStore?: McpToolSnapshotStore;
}

interface McpServerInfo {
  readonly name?: string;
  readonly version?: string;
}

type JsonRpcPayload = JsonRpcResponse | JsonRpcResponse[] | null;

interface ProcessJsonRpcOptions {
  immediateResponse?: http.ServerResponse;
  response?: http.ServerResponse;
  stopKeepalive?: () => void;
}

const JSON_CONTENT_TYPE = { "Content-Type": "application/json" } as const;
const MCP_MAX_BODY_BYTES = 1024 * 1024;
const MCP_MAX_PENDING_CALLS_PER_TOKEN = 64;
const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_KEEPALIVE_INTERVAL_MS = 60_000;
const MCP_SERVER_TIMEOUT_MS = 30 * 60 * 1000;

export function createMcpServer(deps: CreateMcpServerDeps): McpServer {
  void deps.registry;
  const snapshotStore = deps.toolSnapshotStore ?? createMcpToolSnapshotStore();
  const serverInfo = {
    name: deps.serverInfo?.name ?? "core-mcp-tools",
    version: deps.serverInfo?.version ?? "1.0.0",
  };
  let activeServer: http.Server | null = null;
  let activeServerUrl: string | null = null;
  let activeOpaquePath: string | null = null;
  let activeStartPromise: Promise<string> | null = null;
  let activeStopPromise: Promise<void> | null = null;
  const callQueues = new Map<string, PendingToolCall[]>();
  const resultQueues = new Map<string, PendingToolResult[]>();
  const arrivalCallbacks = new Map<string, ToolCallArrivedCallback>();

  function clearPendingForSession(token: string): void {
    const queue = callQueues.get(token);
    if (queue) {
      for (const pending of queue) {
        cleanupPendingToolCall(pending);
        pending.resolve(makeResult(null, {
          content: [{ type: "text", text: "Session closed" }],
          isError: true,
        }));
      }
      callQueues.delete(token);
    }
    resultQueues.delete(token);
  }

  function clearAllMcpState(): void {
    for (const token of Array.from(callQueues.keys())) {
      clearPendingForSession(token);
    }
    resultQueues.clear();
    arrivalCallbacks.clear();
    snapshotStore.clearAllTools();
  }

  function removePendingToolCall(token: string, pending: PendingToolCall): void {
    const queue = callQueues.get(token);
    if (queue) {
      const index = queue.indexOf(pending);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      if (queue.length === 0) {
        callQueues.delete(token);
      }
    }
    cleanupPendingToolCall(pending);
  }

  function stopMcpServerOnce(): Promise<void> {
    const startup = activeStartPromise;
    if (startup) {
      return startup
        .then(() => stopMcpServerOnce())
        .catch(() => {
          activeServer = null;
          activeServerUrl = null;
          activeOpaquePath = null;
          activeStartPromise = null;
          clearAllMcpState();
        });
    }

    const currentServer = activeServer;
    if (!currentServer) {
      activeStartPromise = null;
      clearAllMcpState();
      return Promise.resolve();
    }

    for (const [token] of callQueues) {
      clearPendingForSession(token);
    }

    return new Promise<void>((resolve) => {
      currentServer.close(() => {
        if (activeServer === currentServer) {
          activeServer = null;
          activeServerUrl = null;
          activeOpaquePath = null;
        }
        activeStartPromise = null;
        clearAllMcpState();
        resolve();
      });
      currentServer.closeAllConnections?.();
    });
  }

  async function processJsonRpc(
    req: JsonRpcRequest,
    token: string,
    options?: ProcessJsonRpcOptions,
  ): Promise<JsonRpcResponse | null> {
    const { method, id, params } = req;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        return makeResult(id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo,
        });

      case "notifications/initialized":
        return null;

      case "tools/list": {
        const tools = snapshotStore.getToolsForSession(token);
        const mcpTools = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return makeResult(id, { tools: mcpTools });
      }

      case "tools/call": {
        const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!p?.name) {
          return makeError(id, -32602, "tool name missing");
        }

        const tools = snapshotStore.getToolsForSession(token);
        const tool = tools.find((t) => t.name === p.name);
        if (!tool) {
          return makeError(id, -32602, `tool not found: ${p.name}`);
        }

        const cb = arrivalCallbacks.get(token);
        if (!cb) {
          return makeError(id, -32000, "tool call router is detached");
        }
        const queue = callQueues.get(token);
        if (queue && queue.length >= MCP_MAX_PENDING_CALLS_PER_TOKEN) {
          return makeError(id, -32000, "too many pending tool calls");
        }
        const toolCallId = cb(p.name, p.arguments ?? {});

        const preQueue = resultQueues.get(token);
        if (preQueue && preQueue.length > 0) {
          const pendingResult = preQueue[0]!;
          if (pendingResult.toolCallId === toolCallId) {
            preQueue.shift();
            if (preQueue.length === 0) resultQueues.delete(token);
            return makeResult(id, pendingResult.result);
          }
          return makeError(
            id,
            -32000,
            `MCP FIFO pre-queue mismatch: expected=${toolCallId} actual=${pendingResult.toolCallId}`,
          );
        }

        return new Promise<JsonRpcResponse>((resolve) => {
          let writableQueue = callQueues.get(token);
          if (!writableQueue) {
            writableQueue = [];
            callQueues.set(token, writableQueue);
          }
          const pending: PendingToolCall = {
            toolName: p.name!,
            toolCallId,
            timeout: setTimeout(() => {
              removePendingToolCall(token, pending);
              const payload = makeResult(id, {
                content: [{ type: "text", text: "Tool call timed out" }],
                isError: true,
              });
              if (options?.immediateResponse && !options.immediateResponse.writableEnded) {
                options.stopKeepalive?.();
                options.immediateResponse.end(JSON.stringify(payload));
              }
              resolve(payload);
            }, MCP_TOOL_CALL_TIMEOUT_MS),
            response: options?.response,
            resolve: (result) => {
              const payload = { ...result, id: id ?? null };
              if (options?.immediateResponse && !options.immediateResponse.writableEnded) {
                options.stopKeepalive?.();
                options.immediateResponse.end(JSON.stringify(payload));
              }
              resolve(payload);
            },
          };
          if (options?.response) {
            pending.onResponseClose = () => {
              removePendingToolCall(token, pending);
              options.stopKeepalive?.();
              resolve(makeResult(id, {
                content: [{ type: "text", text: "Client disconnected" }],
                isError: true,
              }));
            };
            options.response.on("close", pending.onResponseClose);
          }
          writableQueue.push(pending);
        });
      }

      default:
        if (isNotification) return null;
        return makeError(id, -32601, `Unsupported method: ${method}`);
    }
  }

  function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.url !== activeOpaquePath) {
      res.writeHead(404);
      res.end();
      return;
    }

    handleAuthorizedRequest(req, res, processJsonRpc);
  }

  return {
    async start() {
      if (activeStopPromise) await activeStopPromise;
      if (activeServer && activeServerUrl) return activeServerUrl;
      if (activeStartPromise) return activeStartPromise;

      activeOpaquePath = `/${crypto.randomUUID()}`;
      activeStartPromise = new Promise<string>((resolve, reject) => {
        const srv = http.createServer(handleRequest);
        srv.timeout = MCP_SERVER_TIMEOUT_MS;
        srv.keepAliveTimeout = MCP_SERVER_TIMEOUT_MS;
        srv.headersTimeout = MCP_SERVER_TIMEOUT_MS + 1000;
        srv.listen(0, "127.0.0.1", () => {
          const addr = srv.address();
          if (!addr || typeof addr === "string") {
            activeStartPromise = null;
            reject(new Error("MCP server bind failed"));
            return;
          }
          activeServer = srv;
          activeServerUrl = `http://127.0.0.1:${addr.port}${activeOpaquePath}`;
          activeStartPromise = null;
          resolve(activeServerUrl);
        });
        srv.on("error", (err) => {
          if (activeServer === srv) {
            activeServer = null;
            activeServerUrl = null;
            activeOpaquePath = null;
          }
          activeStartPromise = null;
          reject(err);
        });
      });

      return activeStartPromise;
    },
    async stop() {
      if (activeStopPromise) return activeStopPromise;
      activeStopPromise = stopMcpServerOnce();
      try {
        await activeStopPromise;
      } finally {
        activeStopPromise = null;
      }
    },
    setOnToolCallArrived(token, cb) {
      if (cb) {
        arrivalCallbacks.set(token, cb);
      } else {
        arrivalCallbacks.delete(token);
      }
    },
    resolveNextToolCall(token, toolCallId, result) {
      const queue = callQueues.get(token);

      if (queue && queue.length > 0) {
        const pending = queue[0]!;
        if (pending.toolCallId !== toolCallId) {
          throw new Error(
            `MCP FIFO head mismatch: expected=${pending.toolCallId} actual=${toolCallId}`,
          );
        }
        queue.shift();
        if (queue.length === 0) callQueues.delete(token);
        cleanupPendingToolCall(pending);
        pending.resolve(makeResult(null, result));
      } else {
        let preQueue = resultQueues.get(token);
        if (!preQueue) {
          preQueue = [];
          resultQueues.set(token, preQueue);
        }
        preQueue.push({ toolCallId, result });
      }
    },
    hasPendingToolCall(token) {
      const queue = callQueues.get(token);
      return !!queue && queue.length > 0;
    },
    clearPendingForSession,
  };
}

function cleanupPendingToolCall(pending: PendingToolCall): void {
  clearTimeout(pending.timeout);
  if (pending.response && pending.onResponseClose) {
    pending.response.off("close", pending.onResponseClose);
  }
}

function handleAuthorizedRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  processJsonRpc: (
    req: JsonRpcRequest,
    token: string,
    options?: ProcessJsonRpcOptions,
  ) => Promise<JsonRpcResponse | null>,
): void {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  req.on("data", (chunk: Buffer) => {
    if (bodyTooLarge) return;
    bodyBytes += chunk.length;
    if (bodyBytes > MCP_MAX_BODY_BYTES) {
      bodyTooLarge = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (bodyTooLarge) return;
    try {
      const body = Buffer.concat(chunks).toString("utf-8");
      const parsed = JSON.parse(body);
      const shouldFlushHeaders = hasToolsCallRequest(parsed);
      let stopKeepalive: () => void = () => undefined;

      if (shouldFlushHeaders) {
        res.writeHead(200, JSON_CONTENT_TYPE);
        res.flushHeaders();
        stopKeepalive = startResponseKeepalive(res);
      }

      if (Array.isArray(parsed)) {
        const results: (JsonRpcResponse | null)[] = [];
        const promises: Promise<void>[] = [];
        for (const item of parsed) {
          promises.push(
            processJsonRpc(
              item,
              token,
              isToolsCallMethod(item) ? { response: res } : undefined,
            ).then((result) => {
              results.push(result);
            }),
          );
        }
        Promise.all(promises)
          .then(() => {
            const filtered = results.filter((r): r is JsonRpcResponse => r !== null);
            sendJsonRpcPayload(
              res,
              filtered.length === 0 ? null : filtered,
              shouldFlushHeaders,
              stopKeepalive,
            );
          })
          .catch(() => {
            sendJsonRpcPayload(
              res,
              makeError(null, -32603, "Internal error"),
              shouldFlushHeaders,
              stopKeepalive,
            );
          });
      } else {
        const options = shouldFlushHeaders && isToolsCallMethod(parsed)
          ? { immediateResponse: res, response: res, stopKeepalive }
          : undefined;

        processJsonRpc(parsed, token, options)
          .then((result) => {
            if (res.writableEnded) return;
            sendJsonRpcPayload(res, result, shouldFlushHeaders, stopKeepalive);
          })
          .catch(() => {
            if (res.writableEnded) return;
            sendJsonRpcPayload(
              res,
              makeError(null, -32603, "Internal error"),
              shouldFlushHeaders,
              stopKeepalive,
            );
          });
      }
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }));
    }
  });
}

function makeResult(
  id: string | number | null | undefined,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function makeError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function hasToolsCallRequest(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => isToolsCallMethod(item));
  }
  return isToolsCallMethod(value);
}

function isToolsCallMethod(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as JsonRpcRequest).method === "tools/call";
}

function sendJsonRpcPayload(
  res: http.ServerResponse,
  payload: JsonRpcPayload,
  headersFlushed: boolean,
  stopKeepalive?: () => void,
): void {
  stopKeepalive?.();
  if (res.writableEnded) return;

  if (payload === null) {
    if (headersFlushed) {
      res.end();
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (!headersFlushed) {
    res.writeHead(200, JSON_CONTENT_TYPE);
  }
  res.end(JSON.stringify(payload));
}

function startResponseKeepalive(res: http.ServerResponse): () => void {
  let closed = false;

  const clearKeepalive = () => {
    if (closed) return;
    closed = true;
    clearInterval(intervalId);
    res.off("close", clearKeepalive);
    res.off("finish", clearKeepalive);
  };

  const intervalId = setInterval(() => {
    if (res.writableEnded) {
      clearKeepalive();
      return;
    }
    res.write(" ");
  }, MCP_KEEPALIVE_INTERVAL_MS);

  res.on("close", clearKeepalive);
  res.on("finish", clearKeepalive);

  return clearKeepalive;
}

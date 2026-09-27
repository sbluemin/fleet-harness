import crypto from "node:crypto";
import http from "node:http";

import {
  createMcpToolSnapshotStore,
  type McpToolSnapshotStore,
} from "../../tools/snapshot.js";
import type { McpCallToolResult } from "../../tools/spec.js";
import type { JsonRpcPayload, JsonRpcRequest, JsonRpcResponse, JsonRpcResultPayload } from "../types.js";

export interface ServedMcpEndpointInfo {
  readonly name?: string;
  readonly version?: string;
}

export interface CreateServedMcpEndpointDeps {
  readonly serverInfo?: ServedMcpEndpointInfo;
  readonly instructions?: string;
  readonly resources?: readonly import("../resources.js").McpResource[];
  readonly toolSnapshotStore?: McpToolSnapshotStore;
  readonly transport?: McpHttpTransport;
  readonly host?: string;
  readonly port?: number;
}

export interface McpHttpTransport {
  mount(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): { url(): Promise<string>; dispose(): void };
}

export type ToolCallArrivedCallback = (
  toolName: string,
  args: Record<string, unknown>,
) => string;

export interface ServedMcpEndpoint {
  start(): Promise<string>;
  stop(): Promise<void>;
  setOnToolCallArrived(token: string, cb: ToolCallArrivedCallback | null): void;
  resolveToolCall(token: string, toolCallId: string, result: McpCallToolResult): void;
  /** Ends a pending call whose result could not be delivered; never re-runs the tool. */
  failToolCall(token: string, toolCallId: string): boolean;
  hasPendingToolCall(token: string): boolean;
  clearPendingForSession(token: string): void;
}

interface PendingToolCall {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly response?: http.ServerResponse;
  onResponseClose?: () => void;
  resolve(result: JsonRpcResponse): void;
  /** Minimal termination with a fixed payload; must not serialize the undelivered result. */
  fail(): void;
}

interface PendingToolResult {
  readonly toolCallId: string;
  readonly result: McpCallToolResult;
}

interface ProcessJsonRpcOptions {
  readonly immediateResponse?: http.ServerResponse;
  readonly response?: http.ServerResponse;
  readonly stopKeepalive?: () => void;
}

type JsonRpcHttpPayload = JsonRpcResponse | readonly JsonRpcResponse[] | null;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const JSON_CONTENT_TYPE = { "Content-Type": "application/json" } as const;
const MCP_MAX_BODY_BYTES = 1024 * 1024;
const MCP_MAX_PENDING_CALLS_PER_TOKEN = 64;
const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_KEEPALIVE_INTERVAL_MS = 60_000;
const MCP_SERVER_TIMEOUT_MS = 30 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_RESULT_DELIVERY_FAILED_TEXT =
  "Tool result delivery failed; the tool may already have run and its effects may have occurred. Do not assume it did not execute.";

export function createServedMcpEndpoint(deps: CreateServedMcpEndpointDeps = {}): ServedMcpEndpoint {
  const snapshotStore = deps.toolSnapshotStore ?? createMcpToolSnapshotStore();
  const serverInfo = {
    name: deps.serverInfo?.name ?? "core-agent-tools",
    version: deps.serverInfo?.version ?? "1.0.0",
  };
  const host = deps.host ?? DEFAULT_HOST;
  const port = deps.port ?? DEFAULT_PORT;
  const callQueues = new Map<string, PendingToolCall[]>();
  const arrivingResults = new Map<string, PendingToolResult[]>();
  const arrivalCallbacks = new Map<string, ToolCallArrivedCallback>();
  let hosted: ReturnType<McpHttpTransport["mount"]> | null = null;
  let activeServer: http.Server | null = null;
  let activeServerUrl: string | null = null;
  let activeOpaquePath: string | null = null;
  let activeStartPromise: Promise<string> | null = null;
  let activeStopPromise: Promise<void> | null = null;

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
    arrivingResults.delete(token);
  }

  function clearAllMcpState(): void {
    for (const token of Array.from(callQueues.keys())) {
      clearPendingForSession(token);
    }
    arrivingResults.clear();
    arrivalCallbacks.clear();
    snapshotStore.clearAllTools();
  }

  function removePendingToolCall(token: string, pending: PendingToolCall): void {
    const queue = callQueues.get(token);
    if (queue) {
      const index = queue.indexOf(pending);
      if (index >= 0) queue.splice(index, 1);
      if (queue.length === 0) callQueues.delete(token);
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

    if (deps.resources && !snapshotStore.hasSession(token)) {
      return isNotification ? null : makeError(id, -32001, "Unauthorized session");
    }
    switch (method) {
      case "initialize":
        return makeResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { ...(snapshotStore.getToolsForSession(token).length || !deps.resources ? { tools: {} } : {}), ...(deps.resources ? { resources: {} } : {}) },
          serverInfo,
          ...(deps.instructions ? { instructions: deps.instructions } : {}),
        });

      case "notifications/initialized":
        return null;

      case "tools/list":
        return makeResult(id, {
          tools: snapshotStore.getToolsForSession(token).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });

      case "tools/call":
        return processToolCall(id, params, token, options);

      case "resources/list":
        if (!deps.resources) return makeError(id, -32601, "Resources are not supported");
        return makeResult(id, { resources: deps.resources.map(({ read: _read, ...resource }) => resource) });

      case "resources/templates/list":
        if (!deps.resources) return makeError(id, -32601, "Resources are not supported");
        return makeResult(id, { resourceTemplates: [] });

      case "resources/read": {
        if (!deps.resources) return makeError(id, -32601, "Resources are not supported");
        const uri = (params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri !== "string") return makeError(id, -32602, "Resource URI is required");
        const resource = deps.resources.find((entry) => entry.uri === uri);
        if (!resource) return makeError(id, -32002, "Resource not found");
        const text = await resource.read({ sessionToken: token });
        if (!snapshotStore.hasSession(token)) return makeError(id, -32001, "Session closed");
        return makeResult(id, { contents: [{ uri, mimeType: resource.mimeType, text }] });
      }

      case "ping":
        return makeResult(id, {});

      default:
        if (isNotification) return null;
        return makeError(id, -32601, `Unsupported method: ${method}`);
    }
  }

  function processToolCall(
    id: string | number | null | undefined,
    params: unknown,
    token: string,
    options?: ProcessJsonRpcOptions,
  ): Promise<JsonRpcResponse> | JsonRpcResponse {
    const p = params as { readonly name?: string; readonly arguments?: Record<string, unknown> } | undefined;
    if (!p?.name) {
      return makeError(id, -32602, "tool name missing");
    }

    const toolName = p.name;
    if (!snapshotStore.getToolNamesForSession(token).has(toolName)) {
      return makeError(id, -32602, `tool not found: ${toolName}`);
    }

    const cb = arrivalCallbacks.get(token);
    if (!cb) {
      return makeError(id, -32000, "tool call router is detached");
    }

    const queue = callQueues.get(token);
    if (queue && queue.length >= MCP_MAX_PENDING_CALLS_PER_TOKEN) {
      return makeError(id, -32000, "too many pending tool calls");
    }

    const previousResults = arrivingResults.get(token);
    const synchronousResults: PendingToolResult[] = [];
    arrivingResults.set(token, synchronousResults);
    let toolCallId: string;
    try {
      toolCallId = cb(toolName, p.arguments ?? {});
    } finally {
      if (arrivingResults.get(token) === synchronousResults) {
        if (previousResults) arrivingResults.set(token, previousResults);
        else arrivingResults.delete(token);
      }
    }
    const synchronousResult = synchronousResults.find((entry) => entry.toolCallId === toolCallId);
    if (synchronousResult) return makeResult(id, synchronousResult.result);

    return new Promise<JsonRpcResponse>((resolvePromise) => {
      let writableQueue = callQueues.get(token);
      if (!writableQueue) {
        writableQueue = [];
        callQueues.set(token, writableQueue);
      }
      let settled = false;
      const immediate = options?.immediateResponse;
      const settle = (payload: JsonRpcResponse, body?: string): void => {
        if (immediate && body !== undefined && !immediate.writableEnded) {
          options?.stopKeepalive?.();
          immediate.end(body);
        }
        // Mark settled only after writing, so a write failure still leaves fail() able to end the call.
        settled = true;
        resolvePromise(payload);
      };
      const pending: PendingToolCall = {
        toolName,
        toolCallId,
        timeout: setTimeout(() => {
          if (settled) return;
          removePendingToolCall(token, pending);
          const payload = makeResult(id, {
            content: [{ type: "text", text: "Tool call timed out" }],
            isError: true,
          });
          settle(payload, JSON.stringify(payload));
        }, MCP_TOOL_CALL_TIMEOUT_MS),
        response: options?.response,
        resolve: (result) => {
          if (settled) return;
          const payload = { ...result, id: id ?? null };
          // Serialize before settling so a failure leaves this call open for fail().
          settle(payload, immediate ? JSON.stringify(payload) : undefined);
        },
        fail: () => {
          if (settled) return;
          settled = true;
          const payload = makeDeliveryFailedResult(id);
          if (immediate && !immediate.writableEnded) {
            try {
              options?.stopKeepalive?.();
              immediate.end(JSON.stringify(payload));
            } catch {
              // A partially written body cannot be repaired; drop the connection instead of hanging.
              immediate.destroy();
            }
          }
          resolvePromise(payload);
        },
      };
      if (options?.response) {
        pending.onResponseClose = () => {
          if (settled) return;
          removePendingToolCall(token, pending);
          options.stopKeepalive?.();
          settle(makeResult(id, {
            content: [{ type: "text", text: "Client disconnected" }],
            isError: true,
          }));
        };
        options.response.on("close", pending.onResponseClose);
      }
      writableQueue.push(pending);
    });
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
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

      if (deps.transport) {
        hosted ??= deps.transport.mount((req, res) => handleAuthorizedRequest(req, res, processJsonRpc));
        return hosted.url();
      }
      activeOpaquePath = `/${crypto.randomUUID()}`;
      activeStartPromise = new Promise<string>((resolve, reject) => {
        const srv = http.createServer(handleRequest);
        srv.timeout = MCP_SERVER_TIMEOUT_MS;
        srv.keepAliveTimeout = MCP_SERVER_TIMEOUT_MS;
        srv.headersTimeout = MCP_SERVER_TIMEOUT_MS + 1000;
        srv.listen(port, host, () => {
          const addr = srv.address();
          if (!addr || typeof addr === "string") {
            activeStartPromise = null;
            reject(new Error("MCP server bind failed"));
            return;
          }
          activeServer = srv;
          activeServerUrl = `http://${host}:${addr.port}${activeOpaquePath}`;
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
      if (hosted) { hosted.dispose(); hosted = null; clearAllMcpState(); return; }
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
    resolveToolCall(token, toolCallId, result) {
      const queue = callQueues.get(token);
      const index = queue?.findIndex((pending) => pending.toolCallId === toolCallId) ?? -1;
      if (queue && index >= 0) {
        const pending = queue.splice(index, 1)[0]!;
        if (queue.length === 0) callQueues.delete(token);
        cleanupPendingToolCall(pending);
        try {
          pending.resolve(makeResult(null, result));
        } catch {
          // The timer and queue entry are gone, so this call must be ended here with a fixed payload.
          pending.fail();
        }
        return;
      }

      // Only a result produced inside the arrival callback can precede its pending call.
      arrivingResults.get(token)?.push({ toolCallId, result });
    },
    failToolCall(token, toolCallId) {
      const queue = callQueues.get(token);
      const pending = queue?.find((entry) => entry.toolCallId === toolCallId);
      if (!pending) return false;
      removePendingToolCall(token, pending);
      pending.fail();
      return true;
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
    res.writeHead(401, JSON_CONTENT_TYPE);
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
      res.writeHead(413, JSON_CONTENT_TYPE);
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (bodyTooLarge) return;
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const shouldFlushHeaders = hasToolsCallRequest(parsed);
      let stopKeepalive: () => void = () => undefined;

      if (shouldFlushHeaders) {
        res.writeHead(200, JSON_CONTENT_TYPE);
        res.flushHeaders();
        stopKeepalive = startResponseKeepalive(res);
      }

      processJsonRpcPayload(parsed, token, processJsonRpc, {
        response: res,
        stopKeepalive,
        shouldFlushHeaders,
      }).then((payload) => {
        if (res.writableEnded) return;
        sendJsonRpcPayload(res, payload, shouldFlushHeaders, stopKeepalive);
      }).catch(() => {
        if (res.writableEnded) return;
        sendJsonRpcPayload(
          res,
          makeError(null, -32603, "Internal error"),
          shouldFlushHeaders,
          stopKeepalive,
        );
      });
    } catch {
      res.writeHead(400, JSON_CONTENT_TYPE);
      res.end(JSON.stringify(makeError(null, -32700, "Parse error")));
    }
  });
}

async function processJsonRpcPayload(
  parsed: unknown,
  token: string,
  processJsonRpc: (
    req: JsonRpcRequest,
    token: string,
    options?: ProcessJsonRpcOptions,
  ) => Promise<JsonRpcResponse | null>,
  options: {
    readonly response: http.ServerResponse;
    readonly stopKeepalive: () => void;
    readonly shouldFlushHeaders: boolean;
  },
): Promise<JsonRpcHttpPayload> {
  if (Array.isArray(parsed)) {
    const results = await Promise.all(
      parsed.map((item) =>
        processJsonRpc(
          item,
          token,
          isToolsCallMethod(item) ? { response: options.response } : undefined,
        ),
      ),
    );
    const filtered = results.filter((r): r is JsonRpcResponse => r !== null);
    return filtered.length === 0 ? null : filtered;
  }

  return processJsonRpc(
    parsed as JsonRpcRequest,
    token,
    options.shouldFlushHeaders && isToolsCallMethod(parsed)
      ? {
        immediateResponse: options.response,
        response: options.response,
        stopKeepalive: options.stopKeepalive,
      }
      : undefined,
  );
}

function makeResult(
  id: string | number | null | undefined,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function makeDeliveryFailedResult(id: string | number | null | undefined): JsonRpcResponse {
  return makeResult(id, {
    content: [{ type: "text", text: MCP_RESULT_DELIVERY_FAILED_TEXT }],
    isError: true,
  });
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
  payload: JsonRpcHttpPayload,
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

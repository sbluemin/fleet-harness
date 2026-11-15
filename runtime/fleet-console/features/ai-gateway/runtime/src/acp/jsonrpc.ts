import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/** JSON-RPC 오류 응답. `code`로 호출자가 종류를 가른다. */
export class JsonRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export class JsonRpcClosedError extends Error {
  constructor(message = "The agy process closed before it answered.") {
    super(message);
    this.name = "JsonRpcClosedError";
  }
}

type Json = Record<string, unknown>;

export interface JsonRpcPeerHandlers {
  readonly onNotification: (method: string, params: unknown) => void;
  /** 에이전트가 우리에게 거는 요청. 던지면 `-32603`, `undefined` 메서드는 아래 `unhandled`로 간다. */
  readonly onRequest: (method: string, params: unknown) => unknown | Promise<unknown>;
  readonly onClose: () => void;
}

export interface JsonRpcPeer {
  request<T = unknown>(method: string, params: unknown, options?: { readonly timeoutMs?: number }): Promise<T>;
  notify(method: string, params: unknown): void;
  /** 입력을 끊는다. 이후 대기 중인 요청은 `JsonRpcClosedError`로 끝난다. */
  dispose(): void;
}

/** 줄 단위 JSON-RPC 2.0 피어. `agy acp`의 stdio를 한 줄 = 한 메시지로 읽고 쓴다. */
export function createJsonRpcPeer(child: ChildProcessWithoutNullStreams, handlers: JsonRpcPeerHandlers): JsonRpcPeer {
  let nextId = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer?: NodeJS.Timeout }>();
  const lines = createInterface({ input: child.stdout });

  const write = (message: Json): void => {
    if (closed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const failAll = (error: Error): void => {
    for (const [id, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    lines.close();
    failAll(new JsonRpcClosedError());
    handlers.onClose();
  };

  child.stdin.on("error", () => undefined);
  child.once("close", finish);
  child.once("error", finish);

  lines.on("line", (line) => {
    let message: Json;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Json;
    } catch {
      return; // agy가 가끔 stdout에 섞는 비JSON 줄은 프로토콜이 아니다.
    }
    const id = message.id;
    const method = message.method;
    if (typeof method === "string") {
      if (typeof id === "number" || typeof id === "string") {
        void Promise.resolve()
          .then(() => handlers.onRequest(method, message.params))
          .then(
            (result) => write({ id, result: result ?? null }),
            (error: unknown) => write({
              id,
              error: error instanceof JsonRpcError
                ? { code: error.code, message: error.message }
                : { code: -32603, message: error instanceof Error ? error.message : String(error) },
            }),
          );
      } else {
        handlers.onNotification(method, message.params);
      }
      return;
    }
    if (typeof id !== "number") return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const error = message.error;
    if (typeof error === "object" && error !== null) {
      const { code, message: text, data } = error as { code?: unknown; message?: unknown; data?: unknown };
      entry.reject(new JsonRpcError(typeof code === "number" ? code : -32603, typeof text === "string" ? text : "JSON-RPC error", data));
    } else {
      entry.resolve(message.result);
    }
  });

  return {
    request<T>(method: string, params: unknown, options?: { readonly timeoutMs?: number }): Promise<T> {
      if (closed) return Promise.reject(new JsonRpcClosedError());
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const entry: { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer?: NodeJS.Timeout } = {
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        if (options?.timeoutMs !== undefined) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`agy did not answer ${method} within ${options.timeoutMs}ms.`));
          }, options.timeoutMs);
        }
        pending.set(id, entry);
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write({ method, params });
    },
    dispose() {
      finish();
    },
  };
}

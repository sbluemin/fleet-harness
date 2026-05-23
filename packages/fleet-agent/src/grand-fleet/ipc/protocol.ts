/**
 * Grand Fleet IPC에서 사용하는 ndJSON 프레이밍과 JSON-RPC 메시지 유틸리티를 제공한다.
 */

import type { Socket } from "node:net";

import { MAX_MESSAGE_SIZE } from "../types.js";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types.js";

type JsonRpcParams = Record<string, unknown>;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return ("result" in msg || "error" in msg) && "id" in msg;
}

export function isNotification(
  msg: JsonRpcMessage,
): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function createFramer(
  socket: Socket,
  onMessage: (msg: JsonRpcMessage) => void,
  onError?: (err: Error) => void,
): void {
  let buffer = "";

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");

    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line) {
        continue;
      }

      if (line.length > MAX_MESSAGE_SIZE) {
        onError?.(
          new Error(`메시지 크기 초과: ${line.length} > ${MAX_MESSAGE_SIZE}`),
        );
        continue;
      }

      try {
        const parsed = JSON.parse(line) as JsonRpcMessage;
        onMessage(parsed);
      } catch (error) {
        onError?.(new Error(`JSON 파싱 실패: ${(error as Error).message}`));
      }
    }

    // 버퍼가 개행 없이 계속 누적되는 경우를 방지한다.
    if (buffer.length > MAX_MESSAGE_SIZE) {
      onError?.(new Error(`버퍼 오버플로우: ${buffer.length} > ${MAX_MESSAGE_SIZE}`));
      buffer = "";
    }
  });
}

export function sendMessage(socket: Socket, message: JsonRpcMessage): void {
  const json = JSON.stringify(message) + "\n";
  socket.write(json, "utf-8");
}

export function createJsonRpcRequest(
  method: string,
  params: JsonRpcParams,
  id: number | string,
): JsonRpcRequest {
  return { jsonrpc: "2.0", method, params, id };
}

export function createJsonRpcNotification(
  method: string,
  params: JsonRpcParams,
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function createJsonRpcResponse(
  id: number | string,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", result, id };
}

export function createJsonRpcErrorResponse(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", error: { code, message, data }, id };
}

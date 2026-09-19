/**
 * 실행기가 자식에게 물려주는 외부 MCP 서버 기술자.
 *
 * 전송 계층 패키지가 아니라 여기가 소유한다. 자식을 실제로 띄우는 쪽이 이 모양을 자기 프로바이더의
 * 인자로 옮기며, 그 변환은 호출자 몫이다 — 특히 `toolTimeoutSeconds`는 이름 그대로 초 단위이므로
 * 밀리초를 받는 프로바이더는 변환 없이 넘기면 1000배로 어긋난다.
 */
export interface McpServerConfig {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  readonly toolTimeoutSeconds?: number;
}

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcPayload = JsonRpcRequest | readonly JsonRpcRequest[];
export type JsonRpcResultPayload = JsonRpcResponse | readonly JsonRpcResponse[] | null;
export type TrackStatus = "queued" | "conn" | "stream" | "done" | "err" | "aborted";

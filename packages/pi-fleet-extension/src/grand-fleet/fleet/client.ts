/**
 * Fleet JSON-RPC 클라이언트.
 *
 * Fleet 모드에서 Admiralty의 Unix Domain Socket 서버에 접속하고,
 * Admiral (제독) 인스턴스가 Admiral of the Navy (대원수)의 명령 체계를
 * 상위로부터 수신할 수 있도록 Request/Response 매칭과 재연결을 관리한다.
 */
import * as net from "node:net";

import type { JsonRpcMessage, JsonRpcResponse } from "@sbluemin/fleet-core/admiralty";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from "@sbluemin/fleet-core/admiralty";
import {
  createFramer,
  sendMessage,
  isRequest,
  isResponse,
  createJsonRpcRequest,
  createJsonRpcNotification,
  createJsonRpcResponse,
  createJsonRpcErrorResponse,
} from "../protocol.js";
import { infra } from "@sbluemin/fleet-core";

type ConnectionState = "disconnected" | "connecting" | "connected";
type RequestHandler = (params: Record<string, unknown>) => Promise<unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;
const LOG_SOURCE = "grand-fleet-ipc";

export class FleetClient {
  private socket: net.Socket | null = null;
  private state: ConnectionState = "disconnected";
  private socketPath: string;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private requestHandlers = new Map<string, RequestHandler>();
  private nextId = 1;
  private intentionalClose = false;
  private onConnected?: () => void;
  private onDisconnected?: () => void;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** Admiralty→Fleet 방향의 Request 핸들러 등록 */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** 연결 이벤트 콜백 */
  onConnect(cb: () => void): void {
    this.onConnected = cb;
  }

  /** 연결 해제 이벤트 콜백 */
  onDisconnect(cb: () => void): void {
    this.onDisconnected = cb;
  }

  /** 접속 시작 */
  connect(): void {
    if (this.state !== "disconnected") return;
    this.intentionalClose = false;
    this.state = "connecting";
    infra.log.getLogAPI().debug(LOG_SOURCE, `Admiralty 접속 시도: ${this.socketPath}`);
    this.attemptConnect();
  }

  /** Request 전송 (응답 대기) */
  async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.socket || this.state !== "connected") {
      throw new Error("연결되지 않은 상태에서 Request 전송 시도");
    }

    const id = `f-${this.nextId++}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request 타임아웃: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      sendMessage(this.socket!, createJsonRpcRequest(method, params, id));
    });
  }

  /** Notification 전송 (응답 없음) */
  sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.socket || this.state !== "connected") return;
    sendMessage(this.socket, createJsonRpcNotification(method, params));
  }

  /** 연결 종료 */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("연결 종료"));
    }

    this.pendingRequests.clear();
    this.socket?.destroy();
    this.socket = null;
    this.state = "disconnected";
  }

  /** 현재 상태 조회 */
  getState(): ConnectionState {
    return this.state;
  }

  private attemptConnect(): void {
    const socket = net.createConnection(this.socketPath);

    socket.on("connect", () => {
      this.socket = socket;
      this.state = "connected";
      this.reconnectDelay = RECONNECT_BASE_MS;
      const log = infra.log.getLogAPI();
      log.info(LOG_SOURCE, `Admiralty 접속 성공: ${this.socketPath}`);
      createFramer(
        socket,
        (msg) => {
          void this.handleMessage(msg);
        },
        (err: Error) => log.error(LOG_SOURCE, `프레이밍 오류: ${err.message}`),
      );
      this.onConnected?.();
    });

    socket.on("close", () => {
      this.socket = null;
      const wasConnected = this.state === "connected";
      this.state = "disconnected";
      if (wasConnected) {
        this.onDisconnected?.();
      }
      if (!this.intentionalClose) {
        if (wasConnected) {
          infra.log.getLogAPI().warn(LOG_SOURCE, "Admiralty 연결 끊김 — 재연결 대기");
        }
        this.scheduleReconnect();
      }
    });

    socket.on("error", (err: Error) => {
      infra.log.getLogAPI().error(LOG_SOURCE, `소켓 오류: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    infra.log.getLogAPI().debug(LOG_SOURCE, `재연결 스케줄: ${this.reconnectDelay}ms 후`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.state = "connecting";
      this.attemptConnect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      RECONNECT_MAX_MS,
    );
  }

  private async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (isResponse(msg)) {
      this.resolvePendingResponse(msg);
      return;
    }

    if (!isRequest(msg)) {
      return;
    }

    if (!this.socket) {
      return;
    }

    const log = infra.log.getLogAPI();
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      log.warn(LOG_SOURCE, `알 수 없는 메서드: ${msg.method}`);
      sendMessage(
        this.socket,
        createJsonRpcErrorResponse(
          msg.id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method not found: ${msg.method}`,
        ),
      );
      return;
    }

    log.debug(LOG_SOURCE, `Admiralty Request 수신: ${msg.method} (id=${msg.id})`);
    try {
      const result = await handler(msg.params ?? {});
      sendMessage(this.socket, createJsonRpcResponse(msg.id, result));
      log.debug(LOG_SOURCE, `Admiralty Request 완료: ${msg.method}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(LOG_SOURCE, `Admiralty Request 실패: ${msg.method} — ${message}`);
      sendMessage(
        this.socket,
        createJsonRpcErrorResponse(
          msg.id,
          JSON_RPC_INTERNAL_ERROR,
          message,
        ),
      );
    }
  }

  private resolvePendingResponse(msg: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.id);

    if (msg.error) {
      pending.reject(new Error(msg.error.message));
      return;
    }

    pending.resolve(msg.result);
  }
}

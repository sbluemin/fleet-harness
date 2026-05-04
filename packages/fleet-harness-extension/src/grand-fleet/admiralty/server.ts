/**
 * Admiralty가 Fleet 연결을 받아
 * JSON-RPC Request/Notification을 처리하는 Unix Domain Socket 서버를 제공한다.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  createFramer,
  sendMessage,
  isRequest,
  isResponse,
  isNotification,
  createJsonRpcResponse,
  createJsonRpcErrorResponse,
  createJsonRpcRequest,
} from "../protocol.js";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@sbluemin/fleet-core/admiralty";
import { infra } from "@sbluemin/fleet-core";

/** Admiralty → Fleet 방향의 메서드 핸들러 */
type RequestHandler = (
  params: Record<string, unknown>,
  fleetSocket: net.Socket,
) => Promise<unknown>;

/** Fleet → Admiralty 방향의 Notification 핸들러 */
type NotificationHandler = (
  params: Record<string, unknown>,
  fleetSocket: net.Socket,
) => void;

type DisconnectHandler = (fleetSocket: net.Socket, reason: string) => void;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const SOCKET_PERMISSION = 0o600;
const REQUEST_TIMEOUT_MS = 30_000;
const LOG_SOURCE = "grand-fleet-ipc";
const GRAND_FLEET_SOCKET_DIR = path.join(os.homedir(), ".pi", "grand-fleet");

export class AdmiraltyServer {
  private server: net.Server | null = null;
  private connections = new Set<net.Socket>();
  private disconnectHandler: DisconnectHandler | null = null;
  private pendingRequests = new Map<net.Socket, Map<number | string, PendingRequest>>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /** 메서드 핸들러 등록 (Request) */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** 메서드 핸들러 등록 (Notification) */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  /** 서버 시작 */
  async start(): Promise<void> {
    const log = infra.log.getLogAPI();
    if (this.server?.listening) {
      log.debug(LOG_SOURCE, `이미 리스닝 중인 서버 재사용: ${this.socketPath}`);
      return;
    }
    removeSocketFileIfExists(this.socketPath);
    ensureSocketDirectory(this.socketPath);
    log.debug(LOG_SOURCE, `서버 시작: ${this.socketPath}`);

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.connections.add(socket);
        this.pendingRequests.set(socket, new Map());
        log.info(LOG_SOURCE, `Fleet 연결 수립 (활성 연결: ${this.connections.size})`);

        createFramer(
          socket,
          (msg) => this.handleMessage(msg, socket),
          (err) => log.error(LOG_SOURCE, `프레이밍 오류: ${err.message}`),
        );

        socket.on("close", () => {
          this.handleSocketTermination(socket, "close");
        });

        socket.on("error", (err) => {
          log.error(LOG_SOURCE, `소켓 오류: ${err.message}`);
          this.handleSocketTermination(socket, `error:${err.message}`);
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => {
        fs.chmodSync(this.socketPath, SOCKET_PERMISSION);
        log.info(LOG_SOURCE, `Admiralty 서버 리스닝: ${this.socketPath}`);
        resolve();
      });
    });
  }

  /** 특정 소켓에 Request 전송 */
  async sendRequest(
    socket: net.Socket,
    method: string,
    params: Record<string, unknown>,
    id: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const pendingBySocket = this.pendingRequests.get(socket);
      if (!pendingBySocket) {
        reject(new Error(`연결되지 않은 Fleet 소켓입니다: ${method}`));
        return;
      }

      const timeout = setTimeout(() => {
        pendingBySocket.delete(id);
        reject(new Error(`Request 타임아웃: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      pendingBySocket.set(id, { resolve, reject, timeout });
      sendMessage(socket, createJsonRpcRequest(method, params, id));
    });
  }

  /** 서버 종료 */
  async close(): Promise<void> {
    const log = infra.log.getLogAPI();
    log.info(LOG_SOURCE, `서버 종료 (활성 연결 ${this.connections.size}개 해제)`);
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        removeSocketFileIfExists(this.socketPath);
        resolve();
        return;
      }

      this.server.close(() => {
        removeSocketFileIfExists(this.socketPath);
        this.server = null;
        resolve();
      });
    });
  }

  /** 수신 메시지 처리 */
  private async handleMessage(
    msg: JsonRpcMessage,
    socket: net.Socket,
  ): Promise<void> {
    if (isRequest(msg)) {
      await this.handleRequestMessage(msg, socket);
      return;
    }

    if (isResponse(msg)) {
      this.handleResponseMessage(msg, socket);
      return;
    }

    if (isNotification(msg)) {
      this.handleNotificationMessage(msg, socket);
    }
  }

  /** Request 메시지를 핸들러에 위임하고 응답을 반환한다. */
  private async handleRequestMessage(
    msg: JsonRpcRequest,
    socket: net.Socket,
  ): Promise<void> {
    const log = infra.log.getLogAPI();
    const handler = this.requestHandlers.get(msg.method);
    if (!handler) {
      log.warn(LOG_SOURCE, `알 수 없는 메서드: ${msg.method}`);
      sendMessage(
        socket,
        createJsonRpcErrorResponse(
          msg.id,
          -32601,
          `Method not found: ${msg.method}`,
        ),
      );
      return;
    }

    log.debug(LOG_SOURCE, `Request 수신: ${msg.method} (id=${msg.id})`);
    try {
      const result = await handler(msg.params ?? {}, socket);
      sendMessage(socket, createJsonRpcResponse(msg.id, result));
      log.debug(LOG_SOURCE, `Request 완료: ${msg.method} (id=${msg.id})`);
    } catch (err) {
      log.error(LOG_SOURCE, `Request 실패: ${msg.method} — ${toErrorMessage(err)}`);
      sendMessage(
        socket,
        createJsonRpcErrorResponse(msg.id, -32603, toErrorMessage(err)),
      );
    }
  }

  /** Notification 메시지를 핸들러에 위임한다. */
  private handleNotificationMessage(
    msg: JsonRpcNotification,
    socket: net.Socket,
  ): void {
    const handler = this.notificationHandlers.get(msg.method);
    if (!handler) return;
    infra.log.getLogAPI().debug(LOG_SOURCE, `Notification 수신: ${msg.method}`);
    handler(msg.params ?? {}, socket);
  }

  private handleResponseMessage(msg: JsonRpcResponse, socket: net.Socket): void {
    const pendingBySocket = this.pendingRequests.get(socket);
    if (!pendingBySocket) return;

    const pending = pendingBySocket.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    pendingBySocket.delete(msg.id);

    if ("error" in msg && msg.error) {
      pending.reject(new Error(msg.error.message));
      return;
    }

    pending.resolve("result" in msg ? msg.result : undefined);
  }

  private handleSocketTermination(socket: net.Socket, reason: string): void {
    const log = infra.log.getLogAPI();
    const wasTracked = this.connections.delete(socket);
    this.cancelPendingRequests(socket, reason);
    this.pendingRequests.delete(socket);
    this.disconnectHandler?.(socket, reason);
    if (wasTracked) {
      log.info(LOG_SOURCE, `Fleet 연결 종료 (활성 연결: ${this.connections.size})`);
    }
  }

  private cancelPendingRequests(socket: net.Socket, reason: string): void {
    const pendingBySocket = this.pendingRequests.get(socket);
    if (!pendingBySocket) return;

    for (const [requestId, pending] of pendingBySocket.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Fleet 연결 종료로 요청 취소: ${String(requestId)} (${reason})`));
    }
    pendingBySocket.clear();
  }
}

function ensureSocketDirectory(socketPath: string): void {
  const dir = path.dirname(socketPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function removeSocketFileIfExists(socketPath: string): void {
  assertGrandFleetSocketPath(socketPath);

  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Unsafe Grand Fleet socket path is a symlink: ${socketPath}`);
  }

  if (!stats.isSocket()) {
    throw new Error(`Unsafe Grand Fleet socket path is not a Unix socket: ${socketPath}`);
  }

  fs.unlinkSync(socketPath);
}

function assertGrandFleetSocketPath(socketPath: string): void {
  const resolvedPath = path.resolve(socketPath);
  const resolvedDir = path.resolve(path.dirname(socketPath));
  const expectedDir = path.resolve(GRAND_FLEET_SOCKET_DIR);

  if (resolvedDir !== expectedDir) {
    throw new Error(`Unsafe Grand Fleet socket path is outside ${expectedDir}: ${resolvedPath}`);
  }

  if (path.basename(resolvedPath) !== "admiralty.sock") {
    throw new Error(`Unsafe Grand Fleet socket filename: ${resolvedPath}`);
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

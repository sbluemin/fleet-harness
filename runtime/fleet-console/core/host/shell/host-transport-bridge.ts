import crypto from "node:crypto";
import type http from "node:http";

import type { DesktopHostCommand, DesktopHostRelay, DesktopHostSnapshot } from "@fleet-console/protocol/desktop";
import { DESKTOP_HOST_FRAME_MAX_CHARS, DESKTOP_HOST_RELAY_ID_HEADER, DESKTOP_HOST_UPLOAD_CHUNK_CHARS, DESKTOP_HOST_UPLOAD_DEADLINE_MS, DESKTOP_HOST_UPLOAD_QUEUE, DESKTOP_HOST_UPLOAD_SLOTS, isDesktopHostRelay } from "@fleet-console/protocol/desktop";
import { HOST_RESOURCE_MAX_BYTES, HOST_UPLOAD_MAX_BYTES } from "@fleet-console/protocol/remote/host-transport";

export interface HostShellRequest {
  readonly hostKey: string;
  readonly epoch: number;
  readonly op: DesktopHostCommand["op"];
  readonly routeId: string;
  readonly target: DesktopHostCommand["target"];
  readonly params: Readonly<Record<string, unknown>>;
}

export interface HostShellBridge {
  attached(): boolean;
  snapshot(): DesktopHostSnapshot;
  subscribe(write: (frame: string) => void): () => void;
  relay(value: unknown): Promise<boolean>;
  /**
   * 큰 relay 본문을 받을 자격. 지금 기다리는 비스트리밍 자원 호출(`bytes` GET)일 때만, 그 번호당 한 번에 하나만 준다.
   * `signal`은 그 호출이 끝나는 순간(응답·취소·시간 초과·셸 이탈) 중단된다 — 읽던 큰 본문을 그때 버리라는 뜻이다.
   * `release`는 여러 번 불러도 한 번만 반납한다. 그 밖의 번호(일반 http·스트림·소켓·끝난 번호·모르는 번호)는 null이다.
   */
  claimResourceRelay(id: number): { readonly signal: AbortSignal; release(): void } | null;
  call(request: HostShellRequest, signal?: AbortSignal): Promise<DesktopHostRelay>;
  /** 프레임은 끝날 때까지 같은 명령에 실려 온다. 취소는 abort 명령을 셸에 보낸다. */
  open(request: HostShellRequest, onFrame: (relay: DesktopHostRelay) => Promise<void> | void, signal?: AbortSignal): Promise<DesktopHostRelay>;
}

/** JSON·텍스트·소켓·끝난 번호 relay 한 건의 본문 상한(예전과 같다). */
const RELAY_TEXT_MAX_BYTES = 1024 * 1024;
const RESOURCE_BASE64_MAX_CHARS = Math.ceil(HOST_RESOURCE_MAX_BYTES / 3) * 4;
/** 자원 relay 본문 상한: 가장 큰 자원의 base64와 작은 봉투. */
const RELAY_MAX_BYTES = RESOURCE_BASE64_MAX_CHARS + 64 * 1024;
/** 거절할 본문을 버리며 읽는 최대 길이(정상 자원 relay 크기까지). 이를 넘는 본문은 더 읽지 않고 연결을 닫는다. */
const RELAY_DRAIN_MAX_BYTES = RELAY_MAX_BYTES;

/**
 * 셸이 POST한 relay 하나를 읽어 bridge에 넘기고, 응답 상태를 돌려준다(204 받음, 400 거절, 413 너무 큼).
 * 상한은 본문을 읽기 전에 정한다: 헤더의 명령 번호가 지금 기다리는 자원 호출이면 자원 상한, 아니면 예전 1MiB다.
 * 큰 본문은 그 번호의 자원 응답 모양(본문 id 일치, status·contentType, 올바른 base64, 디코딩 ≤ 자원 상한)일 때만 bridge에 넘긴다.
 * 그래서 대기자 판정·`onFrame`·호출 종료 전에 크기가 묶인다. 413은 본문을 끝까지 읽지 않았을 수 있으므로 호출자가 연결을 닫는다.
 */
export async function relayHostRequest(bridge: HostShellBridge, req: RelayRequest): Promise<204 | 400 | 413> {
  const header = req.headers[DESKTOP_HOST_RELAY_ID_HEADER];
  const id = typeof header === "string" && /^[1-9]\d{0,15}$/u.test(header) ? Number(header) : null;
  const claim = id !== null && Number.isSafeInteger(id) ? bridge.claimResourceRelay(id) : null;
  try {
    const read = await readRelayBody(req, claim?.signal ?? null);
    if ("status" in read) return read.status;
    if (read.total > RELAY_TEXT_MAX_BYTES && (id === null || !isResourceRelay(read.value, id))) return 413;
    return await bridge.relay(read.value) ? 204 : 400;
  } finally {
    // 어느 끝(받음·거절·끊김)이든 자격은 한 번만 반납된다.
    claim?.release();
  }
}

type RelayRequest = AsyncIterable<Buffer | string> & { readonly headers: http.IncomingHttpHeaders; destroy?(): void };

/**
 * relay 본문을 읽는다. `claim`이 있으면 자원 상한, 없으면 1MiB다. 넘친 뒤에는 쥐지 않고 버리며 끝까지 읽어 셸이 413을 확실히 받게 하고,
 * 정상 자원 relay보다 큰 본문은 버리기도 상한에서 끊는다. `claim`이 중단되면(그 호출이 끝남) 요청을 즉시 끊고 모은 조각을 버린다.
 */
async function readRelayBody(req: RelayRequest, claim: AbortSignal | null): Promise<{ readonly status: 400 | 413 } | { readonly value: unknown; readonly total: number }> {
  const limit = claim ? RELAY_MAX_BYTES : RELAY_TEXT_MAX_BYTES;
  const stop = (): void => { req.destroy?.(); };
  claim?.addEventListener("abort", stop, { once: true });
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      if (claim?.aborted) return { status: 400 };
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) { chunks.length = 0; if (total > RELAY_DRAIN_MAX_BYTES) return { status: 413 }; continue; }
      chunks.push(buffer);
    }
  } catch {
    return { status: 400 };
  } finally {
    // 다 읽은 뒤에는 끊기 신호를 뗀다. bridge.relay가 호출을 끝내면서 신호가 와도 이 응답 연결을 닫지 않게 한다.
    claim?.removeEventListener("abort", stop);
  }
  if (claim?.aborted) return { status: 400 };
  if (total > limit) return { status: 413 };
  try { return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")), total }; } catch { return { status: 400 }; }
}

function isResourceRelay(value: unknown, id: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const relay = value as { id?: unknown; status?: unknown; contentType?: unknown; dataBase64?: unknown; json?: unknown; text?: unknown };
  if (relay.id !== id || typeof relay.status !== "number" || typeof relay.contentType !== "string") return false;
  if (typeof relay.dataBase64 !== "string" || relay.json !== undefined || relay.text !== undefined) return false;
  // 길이만 보면 base64가 아닌 문자열도, 상한보다 1~2바이트 큰 자원도 통과한다. 알파벳과 디코딩될 바이트 수로 판정한다.
  if (relay.dataBase64.length > RESOURCE_BASE64_MAX_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/u.test(relay.dataBase64)) return false;
  const bytes = decodedBase64Bytes(relay.dataBase64);
  return bytes !== null && bytes <= HOST_RESOURCE_MAX_BYTES;
}

const CALL_TIMEOUT_MS = 15_000;
/** 이벤트 구독이 끊어진 뒤, 같은 인스턴스가 돌아올 수 있는 시간. 그 안에 없으면 진행 중인 명령을 닫는다. */
const SHELL_DETACH_MS = 5_000;
const FRAME_PREFIX = "event: desktop:host-transport\ndata: ";

interface Waiter {
  readonly streaming: boolean;
  onFrame?: (relay: DesktopHostRelay) => Promise<void> | void;
  /** 대기자를 끝내되 스냅샷은 다시 보내지 않는다. 너무 큰 프레임을 거를 때 쓴다. */
  settle(relay: DesktopHostRelay): void;
  finish(relay: DesktopHostRelay): void;
}

export function createHostShellBridge(options?: { readonly detachMs?: number }): HostShellBridge {
  const instanceId = crypto.randomUUID();
  const detachMs = options?.detachMs ?? SHELL_DETACH_MS;
  let generation = 0;
  let nextId = 1;
  let nextUploadId = 1;
  let uploadActive = 0;
  let publishing = false;
  let publishAgain = false;
  const pending = new Map<number, DesktopHostCommand>();
  const subscribers = new Set<(frame: string) => void>();
  const waiters = new Map<number, Waiter>();
  // 큰 본문을 지금 읽고 있는 자원 호출 번호와 그 읽기를 끊는 신호. 같은 번호로 큰 본문 두 개를 동시에 쥐지 않는다.
  const resourceReads = new Map<number, AbortController>();
  const uploadWaiters: Array<() => void> = [];
  let detachTimer: ReturnType<typeof setTimeout> | null = null;
  let bridge: HostShellBridge;

  const detachShell = (): void => {
    detachTimer = null;
    if (subscribers.size > 0) return;
    for (const [id, waiter] of [...waiters]) waiter.finish({ id, error: "remote_host_unavailable", end: true });
  };

  const render = (): string => `${FRAME_PREFIX}${JSON.stringify(snapshot())}\n\n`;

  // 상한을 넘는 프레임은 구독자에게 쓰지 않는다. 쓰면 셸이 연결을 끊고 재연결이 밀린다.
  const publish = (): void => {
    if (publishing) {
      publishAgain = true;
      return;
    }
    publishing = true;
    try {
      do {
        publishAgain = false;
        for (;;) {
          generation += 1;
          const frame = render();
          if (frame.length <= DESKTOP_HOST_FRAME_MAX_CHARS) {
            for (const subscriber of subscribers) subscriber(frame);
            break;
          }
          generation -= 1;
          const culprit = [...pending.keys()].at(-1);
          if (culprit === undefined) break;
          const waiter = waiters.get(culprit);
          pending.delete(culprit);
          waiter?.settle({ id: culprit, error: "remote_host_unavailable", end: true });
        }
      } while (publishAgain);
    } finally {
      publishing = false;
    }
  };

  const snapshot = (): DesktopHostSnapshot => ({ instanceId, generation, commands: [...pending.values()] });

  bridge = {
    attached: () => subscribers.size > 0,
    snapshot,
    subscribe(write) {
      if (detachTimer !== null) {
        clearTimeout(detachTimer);
        detachTimer = null;
      }
      subscribers.add(write);
      const frame = render();
      if (frame.length <= DESKTOP_HOST_FRAME_MAX_CHARS) write(frame);
      return () => {
        subscribers.delete(write);
        // 같은 인스턴스의 재구독은 스트림을 유지한다. 셸이 유예 안에 돌아오지 않으면 그때 정리한다.
        if (subscribers.size === 0 && detachTimer === null) {
          detachTimer = setTimeout(detachShell, detachMs);
          detachTimer.unref?.();
        }
      };
    },
    async relay(value) {
      if (!isDesktopHostRelay(value)) return false;
      const waiter = waiters.get(value.id);
      if (!waiter) return value.end === true || value.error !== undefined || (typeof value.uploadAck === "number" && Number.isSafeInteger(value.uploadAck) && value.uploadAck >= 0);
      const uploadAck = typeof value.uploadAck === "number" && Number.isSafeInteger(value.uploadAck) && value.uploadAck >= 0;
      const terminal = value.end === true || value.error !== undefined || uploadAck || (!waiter.streaming && (value.status !== undefined || value.capability !== undefined));
      if (!terminal && value.text === undefined && value.dataBase64 === undefined && value.ready !== true) return false;
      if (!terminal) { await waiter.onFrame?.(value); return true; }
      waiter.finish(value);
      return true;
    },
    claimResourceRelay(id) {
      const waiter = waiters.get(id);
      const command = pending.get(id);
      if (!waiter || waiter.streaming || !command || command.op !== "bytes" || command.params.method !== "GET" || resourceReads.has(id)) return null;
      const reading = new AbortController();
      resourceReads.set(id, reading);
      return {
        signal: reading.signal,
        release: () => { if (resourceReads.get(id) === reading) resourceReads.delete(id); },
      };
    },
    call(request, signal) { return start(request, undefined, signal, false); },
    open(request, onFrame, signal) { return start(request, onFrame, signal, true); },
  };

  function start(request: HostShellRequest, onFrame: Waiter["onFrame"], signal: AbortSignal | undefined, streaming: boolean): Promise<DesktopHostRelay> {
    const inline = !streaming && request.op === "http" && typeof request.params.dataBase64 === "string" ? request.params.dataBase64 : null;
    if (inline !== null && inline.length > DESKTOP_HOST_UPLOAD_CHUNK_CHARS) return transferUpload(request, inline, signal);
    return dispatch(request, onFrame, signal, streaming);
  }

  function dispatch(request: HostShellRequest, onFrame: Waiter["onFrame"], signal: AbortSignal | undefined, streaming: boolean, timeoutMs = CALL_TIMEOUT_MS): Promise<DesktopHostRelay> {
    if (subscribers.size === 0 || signal?.aborted) return Promise.resolve({ id: 0, error: "remote_host_unavailable", end: true });
    const id = nextId;
    nextId += 1;
    const command: DesktopHostCommand = { id, ...request };
    pending.set(id, command);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (relay: DesktopHostRelay): boolean => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (waiters.get(id) !== waiter) return false;
        waiters.delete(id);
        pending.delete(id);
        // 이 호출의 큰 본문을 읽는 중이면 끊는다 — 끝난 호출의 본문을 계속 쥐지 않는다.
        resourceReads.get(id)?.abort();
        resourceReads.delete(id);
        resolve(relay);
        return true;
      };
      const finish = (relay: DesktopHostRelay): void => {
        if (settle(relay)) publish();
      };
      // 취소는 아직 끝나지 않은 전송을 끊는 명령이다. 원격이 이미 받아 들인 일을 되돌리지는 않는다.
      const cancelRemote = (): void => {
        if (subscribers.size === 0) return;
        const uploadId = uploadIdOf(request.params.upload);
        void bridge.call({ ...request, op: "abort", routeId: "abort", params: { commandId: id, ...(uploadId === undefined ? {} : { uploadId }) } }).catch(() => undefined);
      };
      const onAbort = (): void => {
        finish({ id, error: "remote_host_unavailable", end: true });
        cancelRemote();
      };
      if (!streaming) {
        timer = setTimeout(() => {
          finish({ id, error: "remote_host_unavailable", end: true });
          cancelRemote();
        }, timeoutMs);
        timer.unref?.();
      }
      const waiter: Waiter = { streaming, ...(onFrame ? { onFrame } : {}), settle: (relay) => { settle(relay); }, finish };
      waiters.set(id, waiter);
      // 이미 취소된 신호에 리스너를 붙이면 콜백이 호출되지 않는다. 붙인 뒤 한 번 더 본다.
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else publish();
    });
  }

  // 본문 전체는 스냅샷에 두지 않는다. 현재 조각 하나만 올리고, 셸이 받은 뒤에 다음 조각을 보낸다.
  async function transferUpload(request: HostShellRequest, raw: string, signal: AbortSignal | undefined): Promise<DesktopHostRelay> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), DESKTOP_HOST_UPLOAD_DEADLINE_MS);
    timer.unref?.();
    const onParent = (): void => deadline.abort();
    signal?.addEventListener("abort", onParent, { once: true });
    if (signal?.aborted) deadline.abort();
    let granted = false;
    let uploadId = 0;
    let commandId = 0;
    try {
      granted = await acquireUpload(deadline.signal);
      if (!granted) return { id: 0, error: "remote_host_unavailable", end: true };
      const totalBytes = decodedBase64Bytes(raw);
      if (totalBytes === null || totalBytes < 1 || totalBytes > HOST_UPLOAD_MAX_BYTES) return { id: 0, error: "route_denied", end: true };
      uploadId = nextUploadId;
      nextUploadId += 1;
      const count = Math.ceil(raw.length / DESKTOP_HOST_UPLOAD_CHUNK_CHARS);
      let relay: DesktopHostRelay = { id: 0, error: "remote_host_unavailable", end: true };
      for (let index = 0; index < count; index += 1) {
        if (deadline.signal.aborted || subscribers.size === 0) {
          if (commandId !== 0) cancelUpload(request, commandId, uploadId);
          return { id: commandId, error: "remote_host_unavailable", end: true };
        }
        const dataBase64 = raw.slice(index * DESKTOP_HOST_UPLOAD_CHUNK_CHARS, (index + 1) * DESKTOP_HOST_UPLOAD_CHUNK_CHARS);
        relay = await dispatch({
          ...request,
          params: { method: request.params.method, path: request.params.path, upload: { id: uploadId, index, count, totalBytes }, dataBase64 },
        }, undefined, deadline.signal, false);
        commandId = relay.id;
        if (relay.error !== undefined || deadline.signal.aborted) {
          cancelUpload(request, commandId, uploadId);
          return relay.error !== undefined ? relay : { id: commandId, error: "remote_host_unavailable", end: true };
        }
        if (index < count - 1 && relay.uploadAck !== index) {
          cancelUpload(request, commandId, uploadId);
          return { id: commandId, error: "remote_host_unavailable", end: true };
        }
      }
      return relay;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onParent);
      if (granted) releaseUpload();
    }
  }

  function cancelUpload(request: HostShellRequest, commandId: number, uploadId: number): void {
    if (subscribers.size === 0 || commandId <= 0) return;
    void bridge.call({ ...request, op: "abort", routeId: "abort", params: { commandId, uploadId } }).catch(() => undefined);
  }

  function acquireUpload(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (uploadActive < DESKTOP_HOST_UPLOAD_SLOTS) {
      uploadActive += 1;
      return Promise.resolve(true);
    }
    if (uploadWaiters.length >= DESKTOP_HOST_UPLOAD_QUEUE) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const grant = (): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          uploadWaiters.shift()?.();
          resolve(false);
          return;
        }
        uploadActive += 1;
        resolve(true);
      };
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        const index = uploadWaiters.indexOf(grant);
        if (index >= 0) uploadWaiters.splice(index, 1);
        resolve(false);
      };
      uploadWaiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  function releaseUpload(): void {
    uploadActive = Math.max(0, uploadActive - 1);
    uploadWaiters.shift()?.();
  }

  return bridge;
}

function uploadIdOf(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function decodedBase64Bytes(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

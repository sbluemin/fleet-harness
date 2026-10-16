import crypto from "node:crypto";

import type { DesktopHostCommand, DesktopHostRelay, DesktopHostSnapshot } from "@fleet-console/protocol/desktop";
import { DESKTOP_HOST_FRAME_MAX_CHARS, DESKTOP_HOST_UPLOAD_CHUNK_CHARS, DESKTOP_HOST_UPLOAD_DEADLINE_MS, DESKTOP_HOST_UPLOAD_QUEUE, DESKTOP_HOST_UPLOAD_SLOTS, isDesktopHostRelay } from "@fleet-console/protocol/desktop";
import { HOST_UPLOAD_MAX_BYTES } from "@fleet-console/protocol/remote/host-transport";

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
  call(request: HostShellRequest, signal?: AbortSignal): Promise<DesktopHostRelay>;
  /** 프레임은 끝날 때까지 같은 명령에 실려 온다. 취소는 abort 명령을 셸에 보낸다. */
  open(request: HostShellRequest, onFrame: (relay: DesktopHostRelay) => Promise<void> | void, signal?: AbortSignal): Promise<DesktopHostRelay>;
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

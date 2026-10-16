import crypto from "node:crypto";

import type { DesktopHostCommand, DesktopHostRelay, DesktopHostSnapshot } from "@fleet-console/protocol/desktop";
import { isDesktopHostRelay } from "@fleet-console/protocol/desktop";

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

interface Waiter {
  readonly streaming: boolean;
  onFrame?: (relay: DesktopHostRelay) => Promise<void> | void;
  finish(relay: DesktopHostRelay): void;
}

export function createHostShellBridge(): HostShellBridge {
  const instanceId = crypto.randomUUID();
  let generation = 0;
  let nextId = 1;
  const pending = new Map<number, DesktopHostCommand>();
  const subscribers = new Set<(frame: string) => void>();
  const waiters = new Map<number, Waiter>();
  let bridge: HostShellBridge;

  const publish = (): void => {
    generation += 1;
    const frame = `event: desktop:host-transport\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const subscriber of subscribers) subscriber(frame);
  };

  const snapshot = (): DesktopHostSnapshot => ({ instanceId, generation, commands: [...pending.values()] });

  bridge = {
    attached: () => subscribers.size > 0,
    snapshot,
    subscribe(write) {
      subscribers.add(write);
      write(`event: desktop:host-transport\ndata: ${JSON.stringify(snapshot())}\n\n`);
      return () => {
        subscribers.delete(write);
        if (subscribers.size === 0) {
          for (const [id, waiter] of waiters) waiter.finish({ id, error: "remote_host_unavailable", end: true });
          waiters.clear();
          pending.clear();
        }
      };
    },
    async relay(value) {
      if (!isDesktopHostRelay(value)) return false;
      const waiter = waiters.get(value.id);
      if (!waiter) return value.end === true || value.error !== undefined;
      const terminal = value.end === true || value.error !== undefined || (!waiter.streaming && (value.status !== undefined || value.capability !== undefined));
      if (!terminal && value.text === undefined && value.dataBase64 === undefined && value.ready !== true) return false;
      if (!terminal) { await waiter.onFrame?.(value); return true; }
      waiter.finish(value);
      return true;
    },
    call(request, signal) { return start(request, undefined, signal, false); },
    open(request, onFrame, signal) { return start(request, onFrame, signal, true); },
  };

  function start(request: HostShellRequest, onFrame: Waiter["onFrame"], signal: AbortSignal | undefined, streaming: boolean): Promise<DesktopHostRelay> {
    if (subscribers.size === 0 || signal?.aborted) return Promise.resolve({ id: 0, error: "remote_host_unavailable", end: true });
    const id = nextId;
    nextId += 1;
    const command: DesktopHostCommand = { id, ...request };
    pending.set(id, command);
    return new Promise((resolve) => {
      const timer = streaming ? null : setTimeout(() => finish({ id, error: "remote_host_unavailable", end: true }), CALL_TIMEOUT_MS);
      const finish = (relay: DesktopHostRelay): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (waiters.get(id) !== waiter) return;
        waiters.delete(id);
        pending.delete(id);
        resolve(relay);
        publish();
      };
      const onAbort = (): void => {
        finish({ id, error: "remote_host_unavailable", end: true });
        if (streaming && subscribers.size > 0) void bridge.call({ ...request, op: "abort", routeId: "abort", params: { commandId: id } }).catch(() => undefined);
      };
      const waiter: Waiter = { streaming, ...(onFrame ? { onFrame } : {}), finish };
      waiters.set(id, waiter);
      // 이미 취소된 신호에 리스너를 붙이면 콜백이 호출되지 않는다. 붙인 뒤 한 번 더 본다.
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else publish();
    });
  }

  return bridge;
}

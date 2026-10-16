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
  relay(value: unknown): boolean;
  call(request: HostShellRequest, signal?: AbortSignal): Promise<DesktopHostRelay>;
}

const CALL_TIMEOUT_MS = 15_000;

export function createHostShellBridge(): HostShellBridge {
  let generation = 0;
  let nextId = 1;
  const pending = new Map<number, DesktopHostCommand>();
  const subscribers = new Set<(frame: string) => void>();
  const waiters = new Map<number, (relay: DesktopHostRelay) => void>();

  const publish = (): void => {
    generation += 1;
    const frame = `event: desktop:host-transport\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const subscriber of subscribers) subscriber(frame);
  };

  const snapshot = (): DesktopHostSnapshot => ({ generation, commands: [...pending.values()] });

  return {
    attached: () => subscribers.size > 0,
    snapshot,
    subscribe(write) {
      subscribers.add(write);
      write(`event: desktop:host-transport\ndata: ${JSON.stringify(snapshot())}\n\n`);
      return () => {
        subscribers.delete(write);
        if (subscribers.size === 0) {
          for (const [id, resolve] of waiters) resolve({ id, error: "remote_host_unavailable" });
          waiters.clear();
          pending.clear();
        }
      };
    },
    relay(value) {
      if (!isDesktopHostRelay(value)) return false;
      const resolve = waiters.get(value.id);
      if (!resolve) return false;
      const finished = value.end === true || value.error !== undefined || value.status !== undefined || value.capability !== undefined;
      if (!finished && value.text === undefined && value.dataBase64 === undefined) return false;
      resolve(value);
      return true;
    },
    call(request, signal) {
      if (subscribers.size === 0) return Promise.resolve({ id: 0, error: "remote_host_unavailable" });
      const id = nextId;
      nextId += 1;
      const command: DesktopHostCommand = { id, ...request };
      pending.set(id, command);
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish({ id, error: "remote_host_unavailable" }), CALL_TIMEOUT_MS);
        const onAbort = () => finish({ id, error: "remote_host_unavailable" });
        signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (relay: DesktopHostRelay): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (waiters.get(id) !== finishRelay) return;
          waiters.delete(id);
          pending.delete(id);
          resolve(relay);
          publish();
        };
        const finishRelay = (relay: DesktopHostRelay): void => finish(relay);
        waiters.set(id, finishRelay);
        publish();
      });
    },
  };
}

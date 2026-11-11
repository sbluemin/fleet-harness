import type { DesktopBrowserChrome, DesktopBrowserSurface, DesktopBrowserSurfaceRelay } from "@fleet-console/protocol/desktop";

import type { BrowserSurfaceHost, DesktopBrowserViews } from "./browser-views.js";
import type { ManagedBrowserConnection } from "./browser-connection.js";

/**
 * 창이 보고 있는 콘솔과 상관없이, 이 Desktop 이 관리하는 콘솔마다 브라우저 엔진을 유지한다.
 * 원격·비관리 콘솔에는 엔진을 붙이지 않고, 창이 거기서 떠나 있어도 매니지드 콘솔의 뷰는 주차만 한다.
 * 네이티브 표면은 지금 보는 콘솔이 매니지드일 때만 그 세션에 붙고, 그 밖에는 화면에서만 내린다.
 * 그때 열린 표면 lease 를 closed 로 보고하지 않는다.
 */
export interface ManagedBrowserDisplay extends BrowserSurfaceHost {
  conceal(): void;
}

export interface ManagedBrowserHostDeps {
  readonly display: ManagedBrowserDisplay;
  readonly createSession: (connection: ManagedBrowserConnection, surface: BrowserSurfaceHost) => DesktopBrowserViews;
  readonly log?: (message: string) => void;
}

export interface ManagedBrowserHost {
  /** 증명된 매니지드 연결로 세션을 맞추고, `shownOrigin` 이 그중 하나일 때만 표면을 그 세션에 붙인다. */
  sync(connections: readonly ManagedBrowserConnection[], shownOrigin: string | null, alive?: () => boolean): Promise<void>;
  /** 지금 표면에 붙은 매니지드 콘솔. 원격·비관리를 보는 동안은 null. */
  shownConnection(): ManagedBrowserConnection | null;
  shownOrigin(): string | null;
  refresh(): void;
  places(): void;
  relaySurface(surface: DesktopBrowserSurfaceRelay): void;
  stopAll(): void;
}

interface Binding {
  readonly host: BrowserSurfaceHost;
  show(): void;
  park(): void;
  last(): { readonly surface: DesktopBrowserSurface | null; readonly chrome: DesktopBrowserChrome | null } | null;
}

interface Slot {
  connection: ManagedBrowserConnection;
  readonly binding: Binding;
  readonly views: DesktopBrowserViews;
  shown: boolean;
}

function sameConnection(left: ManagedBrowserConnection, right: ManagedBrowserConnection): boolean {
  return left.origin === right.origin && left.token === right.token && left.ownerId === right.ownerId && left.accessPath === right.accessPath;
}

function createBinding(display: ManagedBrowserDisplay): Binding {
  let mode: "park" | "show" = "park";
  let last: { surface: DesktopBrowserSurface | null; chrome: DesktopBrowserChrome | null } | null = null;
  const host: BrowserSurfaceHost = {
    apply(surface, chrome, origin) {
      last = { surface: surface ?? null, chrome: chrome ?? null };
      if (mode === "show") display.apply(surface, chrome, origin);
    },
    target: () => (mode === "show" ? display.target() : null),
    lastPage: () => display.lastPage(),
    inputLocked: () => (mode === "show" ? display.inputLocked() : false),
    focusPageDialog() { if (mode === "show") display.focusPageDialog?.(); },
    refresh() { if (mode === "show") display.refresh(); },
    // 주차 중인 세션을 거둘 때 공유 표면을 닫지 않는다. 보이는 세션만 표면을 놓는다.
    dispose() { if (mode === "show") display.dispose(); },
  };
  return {
    host,
    show() { mode = "show"; },
    park() { mode = "park"; },
    last: () => last,
  };
}

export function createManagedBrowserHost(deps: ManagedBrowserHostDeps): ManagedBrowserHost {
  const log = deps.log ?? (() => {});
  const slots = new Map<string, Slot>();
  let chain: Promise<void> = Promise.resolve();
  let epoch = 0;

  const shownSlot = (): Slot | null => [...slots.values()].find((slot) => slot.shown) ?? null;

  const stopSlot = (slot: Slot): void => {
    // stop 이 surface.dispose 를 부르므로, 먼저 주차해 공유 표면이 닫히지 않게 한다.
    slot.shown = false;
    slot.binding.park();
    slot.views.stop();
  };

  const present = (shownOrigin: string | null): void => {
    const shown = [...slots.values()].find((slot) => slot.connection.origin === shownOrigin) ?? null;
    for (const slot of slots.values()) {
      if (slot === shown) {
        if (slot.shown) continue;
        slot.shown = true;
        slot.binding.show();
        const last = slot.binding.last();
        if (last) deps.display.apply(last.surface, last.chrome, slot.connection.origin);
        slot.views.places();
      } else if (slot.shown) {
        slot.shown = false;
        slot.binding.park();
        slot.views.places();
      }
    }
    if (shown === null) deps.display.conceal();
  };

  const syncNow = async (ticket: number, connections: readonly ManagedBrowserConnection[], shownOrigin: string | null, alive: () => boolean): Promise<void> => {
    if (ticket !== epoch || !alive()) return;
    const wanted = new Map(connections.map((connection) => [connection.key, connection]));
    for (const [key, slot] of [...slots]) {
      const next = wanted.get(key);
      if (next && sameConnection(slot.connection, next)) continue;
      stopSlot(slot);
      slots.delete(key);
    }
    await Promise.all([...wanted.values()].map(async (connection) => {
      if (ticket !== epoch || !alive() || slots.has(connection.key)) return;
      const binding = createBinding(deps.display);
      const views = deps.createSession(connection, binding.host);
      const slot: Slot = { connection, binding, views, shown: false };
      try {
        await views.start(connection.origin);
      } catch (error) {
        stopSlot(slot);
        log(`managed browser session failed key=${connection.key}: ${error instanceof Error ? error.message : "unknown"}`);
        return;
      }
      // 기동 중에 창이 닫히거나 더 새로운 맞춤이 시작됐으면 이 세션은 넣지 않는다.
      if (ticket !== epoch || !alive()) { stopSlot(slot); return; }
      slots.set(connection.key, slot);
    }));
    if (ticket !== epoch || !alive()) return;
    present(shownOrigin);
  };

  return {
    sync(connections, shownOrigin, alive = () => true) {
      const ticket = epoch;
      const run = chain.then(() => syncNow(ticket, connections, shownOrigin, alive));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    shownConnection: () => shownSlot()?.connection ?? null,
    shownOrigin() { return shownSlot()?.connection.origin ?? null; },
    refresh() { for (const slot of slots.values()) slot.views.refresh(); },
    places() { for (const slot of slots.values()) slot.views.places(); },
    relaySurface(surface) { shownSlot()?.views.relaySurface(surface); },
    stopAll() {
      epoch += 1;
      for (const slot of [...slots.values()]) stopSlot(slot);
      slots.clear();
      deps.display.conceal();
    },
  };
}

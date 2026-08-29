// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/codex-host.js", () => ({ setCodexReaderExpandedForSession: vi.fn() }));

import { bindCodexHost } from "../client/host.js";
import {
  closeCodexReader,
  expandCodexReader,
  getReaderState,
  openCodexReader,
  subscribeReader,
} from "../client/reader-store.js";

function boundHost(theaters: ReadonlyArray<{ id: string; label: string }>, activeId: string | null) {
  const listeners = new Set<() => void>();
  return {
    capabilities: {
      consoleState: {
        getTheaters: () => theaters,
        getActiveTheaterId: () => activeId,
        setActiveTheater: vi.fn(),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      navigation: { setSearchParams: vi.fn(), getSearchParam: () => null, subscribe: () => () => undefined },
      surfaces: { open: vi.fn(), close: vi.fn(), closeSurface: vi.fn(), isOpen: () => false },
      rail: { open: vi.fn() },
      consoleEvents: { subscribe: () => () => undefined },
    },
    notify: () => { for (const listener of listeners) listener(); },
    subscriberCount: () => listeners.size,
  };
}

beforeEach(() => {
  bindCodexHost(boundHost([], null).capabilities as never);
});

describe("reader state across host binding", () => {
  // 상주 기여는 App의 install effect보다 먼저 마운트된다(자식 effect가 부모보다 먼저 돈다).
  // 구독 시점에 능력을 한 번 읽고 마는 코드는 그때 빈손을 쥐고, Theater가 붙어도 스냅샷의
  // activeTheaterId가 null로 굳어 공유 링크가 가리킨 문서가 영영 열리지 않았다.
  it("picks up the host that binds after the subscription is already standing", () => {
    const early = subscribeReader(() => undefined);
    const host = boundHost([{ id: "theater-a", label: "A" }], "theater-a");

    bindCodexHost(host.capabilities as never);

    expect(getReaderState().activeTheaterId).toBe("theater-a");
    expect(getReaderState().theaters.map((t) => t.id)).toEqual(["theater-a"]);
    early();
  });

  it("follows later Theater changes through the host's own subscription", () => {
    const host = boundHost([{ id: "theater-a", label: "A" }], "theater-a");
    bindCodexHost(host.capabilities as never);
    const seen: number[] = [];
    const stop = subscribeReader(() => seen.push(1));

    host.notify();

    expect(host.subscriberCount()).toBeGreaterThan(0);
    stop();
  });

  // 구독을 놓아도 호스트 구독까지 끊으면, 다음 구독자는 Theater 변화를 못 듣는다.
  it("keeps listening to the host after the last reader subscriber lets go", () => {
    const host = boundHost([{ id: "theater-a", label: "A" }], "theater-a");
    bindCodexHost(host.capabilities as never);

    const stop = subscribeReader(() => undefined);
    stop();

    expect(host.subscriberCount()).toBeGreaterThan(0);
  });
});

describe("expanding before the host is bound", () => {
  // 상주 기여는 install보다 먼저 마운트된다. 주소가 codexView=full을 싣고 들어온 첫 순간에
  // 능력이 아직 없으면, 던지는 접근자를 쓴 확대는 통째로 사라지고 문서만 축소로 열린다 —
  // 실측에서 공유 확대 링크가 정확히 그렇게 축소로 복원됐다.
  it("opens the slot once the host arrives", () => {
    closeCodexReader();
    // 아직 능력이 없는 상태를 만든다.
    bindCodexHost(null as never);
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();
    expect(getReaderState().codexReaderExpanded).toBe(true);

    const host = boundHost([{ id: "theater-a", label: "A" }], "theater-a");
    bindCodexHost(host.capabilities as never);

    expect(host.capabilities.surfaces.open).toHaveBeenCalledWith({ surfaceId: "codex" });
  });

  it("does not open a slot for an expansion the user already dropped", () => {
    closeCodexReader();
    bindCodexHost(null as never);
    openCodexReader({ kind: "entry", entryId: "tide-model" });
    expandCodexReader();
    closeCodexReader();

    const host = boundHost([], null);
    bindCodexHost(host.capabilities as never);

    expect(host.capabilities.surfaces.open).not.toHaveBeenCalled();
  });
});

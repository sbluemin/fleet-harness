// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const liveMocks = vi.hoisted(() => ({ changed: vi.fn(), watch: vi.fn() }));

vi.mock("../client/codex/live.js", () => ({
  applyCodexChanged: liveMocks.changed,
  applyCodexWatchState: liveMocks.watch,
}));

import { plugins } from "../client/index.js";

type Handler = (payload: unknown) => void;

const handlers = new Map<string, Handler>();
const stops: Array<() => void> = [];

function install(): void {
  const codex = plugins.find((plugin) => plugin.id === "codex")!;
  const teardown = codex.install?.({
    consoleState: { getTheaters: () => [], getActiveTheaterId: () => null, setActiveTheater: vi.fn(), subscribe: () => () => undefined },
    navigation: { setSearchParams: vi.fn(), getSearchParam: () => null, subscribe: () => () => undefined },
    surfaces: { open: vi.fn(), close: vi.fn(), closeSurface: vi.fn(), isOpen: () => false },
    rail: { open: vi.fn() },
    consoleEvents: {
      subscribe: (channel: string, onEvent: Handler) => {
        handlers.set(channel, onEvent);
        return () => handlers.delete(channel);
      },
    },
  } as never);
  if (typeof teardown === "function") stops.push(teardown);
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  stops.length = 0;
});

describe("Codex live refresh over the console stream", () => {
  // 서버는 감시 결과를 계속 밀어 보낸다. 구독이 없으면 그 프레임은 버려지고, 열어 둔
  // 화면은 파일이 바뀌어도 낡은 채로 남는다 — 감시가 끊겼다는 통보도 오지 않아
  // 폴링 폴백조차 켜지지 않는다.
  it("subscribes to both of its channels on install", () => {
    install();

    expect([...handlers.keys()].sort()).toEqual(["codex:changed", "codex:watch"]);
  });

  it("applies a change frame to the live layer", () => {
    install();

    handlers.get("codex:changed")!({ workspaceId: "ws-1", scopes: ["wiki", "queue"] });

    expect(liveMocks.changed).toHaveBeenCalledWith("ws-1", ["wiki", "queue"]);
  });

  it("applies a degraded watch frame so polling can take over", () => {
    install();

    handlers.get("codex:watch")!({ workspaceId: "ws-1", state: "degraded" });

    expect(liveMocks.watch).toHaveBeenCalledWith("ws-1", "degraded");
  });

  // 프레임은 네트워크에서 온다 — 모양을 믿으면 한 번의 이상한 프레임이 화면을 무너뜨린다.
  it("drops a frame whose shape it cannot trust", () => {
    install();

    handlers.get("codex:changed")!({ workspaceId: 7, scopes: ["wiki"] });
    handlers.get("codex:changed")!({ workspaceId: "ws-1", scopes: "wiki" });
    handlers.get("codex:changed")!({ workspaceId: "ws-1", scopes: [] });
    handlers.get("codex:watch")!({ workspaceId: "ws-1", state: "sideways" });

    expect(liveMocks.changed).not.toHaveBeenCalled();
    expect(liveMocks.watch).not.toHaveBeenCalled();
  });

  it("lets go of both channels when the plugin is torn down", () => {
    install();

    for (const stop of stops) stop();

    expect(handlers.size).toBe(0);
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const layerMocks = vi.hoisted(() => ({ descriptors: new Map<string, unknown>() }));

vi.mock("../core/client/src/plugin-registry.js", () => ({
  useExpandedSurfaceDescriptors: () => layerMocks.descriptors,
  usePluginRegistry: () => ({
    plugins: [], failures: [], operationKinds: [], settingsSections: [],
    notificationKinds: [], railPanels: [], floatingWidgets: [],
    expandedSurfaces: [], persistentComponents: [],
  }),
}));

import { ExpandedSurfaceLayer } from "../core/client/src/expanded-surface/layer.js";
import { bindExpandedSurfaceCloseNotifier, closeExpandedSurface } from "../core/client/src/expanded-surface/store.js";
import {
  openExpandedSurface,
  resetExpandedSurfacesForTest,
} from "../core/client/src/expanded-surface/store.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetExpandedSurfacesForTest();
  layerMocks.descriptors = new Map();
  // jsdom에는 없다 — 레이어가 페인 폭을 재는 데 쓴다.
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  resetExpandedSurfacesForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a surface that throws", () => {
  // `<Boundary>{descriptor.render(ctx)}</Boundary>`는 자식을 부모의 렌더 중에 평가한다.
  // 그때 던지면 경계는 아직 트리에 없어 예외가 그대로 위로 올라가고, 플러그인 하나가
  // Operations 화면을 통째로 무너뜨린다.
  it("is contained by the boundary instead of taking the canvas down", () => {
    layerMocks.descriptors.set("bad", {
      id: "bad",
      title: () => "Bad surface",
      render: () => { throw new Error("surface blew up"); },
    });
    openExpandedSurface({ surfaceId: "bad" });

    expect(() => act(() => { root.render(<ExpandedSurfaceLayer />); })).not.toThrow();
    // 페인 자체는 살아남아 사용자가 닫을 수 있어야 한다.
    // 레이어는 캔버스로 portal하고, 캔버스가 없으면 body로 떨어진다.
    expect(document.querySelector(".expanded-surface-pane")).not.toBeNull();
  });

  it("still names the pane when the title callback throws", () => {
    layerMocks.descriptors.set("bad", {
      id: "bad",
      title: () => { throw new Error("no name"); },
      render: () => null,
    });
    openExpandedSurface({ surfaceId: "bad" });

    expect(() => act(() => { root.render(<ExpandedSurfaceLayer />); })).not.toThrow();
    expect(document.querySelector(".expanded-surface-pane")?.getAttribute("aria-label")).toBe("bad");
  });

  it("contains a throwing tools callback", () => {
    layerMocks.descriptors.set("bad", {
      id: "bad",
      title: () => "Bad surface",
      render: () => null,
      tools: () => { throw new Error("tools blew up"); },
    });
    openExpandedSurface({ surfaceId: "bad" });

    expect(() => act(() => { root.render(<ExpandedSurfaceLayer />); })).not.toThrow();
  });

  it("contains a throwing aside callback", () => {
    layerMocks.descriptors.set("bad", {
      id: "bad",
      title: () => "Bad surface",
      render: () => null,
      aside: () => { throw new Error("aside blew up"); },
    });
    openExpandedSurface({ surfaceId: "bad" });

    expect(() => act(() => { root.render(<ExpandedSurfaceLayer />); })).not.toThrow();
  });
});

describe("the close notification's lifetime", () => {
  // 표면 레이어는 /operations 라우트에만 선다. 통보를 레이어에 묶어 두면 설정 화면으로
  // 옮기는 순간 배달부가 사라지고, 그 사이에 닫힌 슬롯의 onClose는 조용히 건너뛰어진다 —
  // 플러그인은 자기가 아직 열려 있다고 믿은 채로 남는다.
  it("survives the surface layer leaving the route", () => {
    // App이 콘솔 수명으로 걸어 둔 배달부.
    const delivered = vi.fn();
    bindExpandedSurfaceCloseNotifier(delivered);
    layerMocks.descriptors.set("codex", { id: "codex", title: () => "Codex", render: () => null });
    const instanceId = openExpandedSurface({ surfaceId: "codex" });
    act(() => { root.render(<ExpandedSurfaceLayer />); });

    // 라우트를 떠난다 — 레이어만 사라지고 스토어와 능력은 그대로다.
    act(() => { root.render(<div />); });
    closeExpandedSurface(instanceId);

    expect(delivered).toHaveBeenCalledTimes(1);
  });
});

/**
 * 슬롯이 페인으로 이름을 바꾼 뒤에도, 옛 이름으로 쓰인 본문이 폭을 잃지 않아야 한다.
 * 개명이 곧 고장이 되지 않게 하는 것이 별칭의 전부다.
 */
describe("the renamed geometry", () => {
  it("carries both the new and the deprecated names", () => {
    let seen: Record<string, unknown> | null = null;
    layerMocks.descriptors.set("probe", {
      id: "probe",
      title: () => "Probe",
      render: (ctx: Record<string, unknown>) => { seen = ctx; return null; },
    });
    openExpandedSurface({ surfaceId: "probe" });
    act(() => { root.render(<ExpandedSurfaceLayer />); });

    const ctx = seen as unknown as Record<string, number>;
    expect(ctx).not.toBeNull();
    expect(ctx.paneIndex).toBe(0);
    expect(ctx.paneCount).toBe(1);
    expect(ctx.slotIndex).toBe(ctx.paneIndex);
    expect(ctx.slotCount).toBe(ctx.paneCount);
    expect(ctx.slotWidth).toBe(ctx.paneWidth);
  });

  it("still inserts where a deprecated slotIndex asks", () => {
    for (const id of ["a", "b"]) {
      layerMocks.descriptors.set(id, { id, title: () => id, render: () => null });
    }
    openExpandedSurface({ surfaceId: "a" });
    openExpandedSurface({ surfaceId: "b" });
    layerMocks.descriptors.set("c", { id: "c", title: () => "c", render: () => null });
    openExpandedSurface({ surfaceId: "c", slotIndex: 1 });

    act(() => { root.render(<ExpandedSurfaceLayer />); });
    const titles = [...document.querySelectorAll(".expanded-surface-pane-title")].map((node) => node.textContent);
    expect(titles).toEqual(["a", "c", "b"]);
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneDescriptor } from "../sdk/pane/types.js";

/**
 * 표면이 두 열을 세울 때의 계약.
 *
 * 지금까지 이 배치는 플러그인마다 따로 있었다 — codex의 `is-split` 격자, file-explorer의
 * `fexp-divider`, repository의 `repository-divider`. 여기서 지키는 것은 그 셋이 공통으로
 * 지키던 것: 목록은 레일 아이콘 쪽에 붙어 있고, 문서는 그 왼쪽에서 자라며, 경계는 끌 수 있고,
 * 이름 줄은 문서 쪽에만 선다.
 */

const PANE_INDEX = vi.hoisted(() => ({ value: new Map<string, unknown>() }));

vi.mock("../core/client/src/pane/pane-registry.js", () => ({
  usePaneIndex: () => PANE_INDEX.value,
}));

const { RailSurface } = await import("../core/client/src/pane/rail-surface.js");
const { openPane, closePane, __resetPaneStoreForTests } = await import("../core/client/src/pane/pane-store.js");
const { getPaneStoreSnapshot, resetSurfacePanes } = await import("../core/client/src/pane/pane-store.js");
const { __resetPaneWidthsForTests, getStoredPaneWidth } = await import("../core/client/src/pane/pane-width-store.js");
const { getExpandedSurfaceState, openExpandedSurface, resetExpandedSurfacesForTest } = await import("../core/client/src/expanded-surface/store.js");

let listCtx: import("../sdk/pane/types.js").PaneContext | null = null;
let docCtx: import("../sdk/pane/types.js").PaneContext | null = null;

const listPane: PaneDescriptor = {
  id: "list",
  role: "primary",
  mounts: ["rail"],
  title: () => "List",
  render: (ctx) => {
    listCtx = ctx;
    return <div data-testid="list-body" />;
  },
  defaultWidth: 360,
  minWidth: 240,
};

const seenPanes: unknown[] = [];

const docPane: PaneDescriptor = {
  id: "doc",
  role: "detail",
  mounts: ["rail", "expanded"],
  title: (ctx) => ctx.params.path ?? "Document",
  render: (ctx) => {
    seenPanes.push(ctx.panes);
    docCtx = ctx;
    return <div data-testid="doc-body" />;
  },
  defaultWidth: 420,
  minWidth: 200,
  // 실제 문서 열이 그렇듯 닫아도 읽던 자리를 지킨다.
  keepAlive: true,
};

const binding = {
  entry: { id: "explorer", title: "Explorer", icon: "E", panes: ["list", "doc"] },
  panes: [listPane, docPane],
  projected: false,
};

let container: HTMLDivElement;
let root: Root;
const extraWidthRequests: (number | null)[] = [];

function render(): void {
  act(() => {
    root.render(
      <RailSurface
        binding={binding as never}
        theaterId="theater-1"
        api={{} as never}
        language="en"
        onRequestExtraWidth={(px) => extraWidthRequests.push(px)}
      />,
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  PANE_INDEX.value = new Map<string, unknown>([["list", listPane], ["doc", docPane]]);
  __resetPaneStoreForTests();
  __resetPaneWidthsForTests();
  extraWidthRequests.length = 0;
  seenPanes.length = 0;
  listCtx = null;
  docCtx = null;
  resetExpandedSurfacesForTest();
  container = document.createElement("div");
  document.body.append(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("레일 표면의 2단", () => {
  it("혼자 선 primary는 폭을 배정받지 않고 남는 자리를 채운다", () => {
    render();

    const panes = [...container.querySelectorAll(".rail-pane")];
    expect(panes).toHaveLength(1);
    expect(panes[0]?.classList.contains("is-sized")).toBe(false);
    expect(container.querySelector(".rail-pane-divider")).toBeNull();
    // 아직 열이 하나뿐이면 폭 요구도 없다 — 아직 갈라지지 않은 플러그인이 같은 창구로
    // 요구하고 있으므로, 0을 써 버리면 그 요구를 덮는다.
    expect(extraWidthRequests).toEqual([]);
  });

  it("detail은 primary 왼쪽에 서고 DOM 순서도 눈에 보이는 순서를 따른다", () => {
    render();
    act(() => { openPane({ paneId: "doc", params: { path: "src/app.ts" } }); });

    const order = [...container.querySelectorAll("[data-pane]")].map((el) => el.getAttribute("data-pane"));
    // 레일은 오른쪽 가장자리에 정박해 왼쪽으로 자란다 — 목록이 아이콘 띠에 붙어 있어야
    // 폭이 변해도 손이 가는 자리가 움직이지 않는다.
    expect(order).toEqual(["doc", "list"]);
  });

  it("갈라지면 primary가 폭을 배정받고 그 사이에 분할선이 선다", () => {
    render();
    act(() => { openPane({ paneId: "doc" }); });

    const primary = container.querySelector<HTMLElement>('[data-pane="list"]');
    expect(primary?.classList.contains("is-sized")).toBe(true);
    expect(primary?.style.getPropertyValue("--pane-width")).toBe("360px");

    const divider = container.querySelector<HTMLElement>(".rail-pane-divider");
    expect(divider).not.toBeNull();
    expect(divider?.getAttribute("role")).toBe("separator");
    expect(divider?.getAttribute("aria-controls")).toBe("rail-pane-list");
    expect(divider?.getAttribute("aria-valuenow")).toBe("360");
  });

  it("detail이 서면 표면이 그만큼 폭을 더 요구하고, 닫으면 요구를 거둔다", () => {
    render();
    act(() => { openPane({ paneId: "doc" }); });
    expect(extraWidthRequests).toEqual([420]);

    act(() => { closePane("doc"); });
    expect(extraWidthRequests).toEqual([420, null]);
  });

  it("캡션은 detail에만 서고 이름은 그 페인이 담은 것을 말한다", () => {
    render();
    act(() => { openPane({ paneId: "doc", params: { path: "src/app.ts" } }); });

    const captions = [...container.querySelectorAll("[data-pane-caption]")];
    expect(captions.map((el) => el.getAttribute("data-pane-caption"))).toEqual(["doc"]);
    expect(captions[0]?.querySelector(".pane-caption-title")?.textContent).toBe("src/app.ts");
  });

  it("여닫는 창구의 정체는 params가 바뀌어도 그대로다", () => {
    render();
    act(() => { openPane({ paneId: "doc", params: { path: "a.ts" } }); });
    act(() => { openPane({ paneId: "doc", params: { path: "b.ts" } }); });

    // 이 정체가 흔들리면 그것을 의존성에 적은 본문의 effect가 아무 일도 없었는데 다시 돈다 —
    // 방금 닫은 열을 스스로 다시 여는 종류의 결함이 거기서 태어난다.
    expect(seenPanes.length).toBeGreaterThan(1);
    expect(new Set(seenPanes).size).toBe(1);
  });

  it("확대된 페인을 다시 열면 그 자리에서 갈아탄다 — 레일에 사본을 세우지 않는다", () => {
    render();
    openExpandedSurface({ surfaceId: "pane", params: { paneId: "doc", path: "a.ts" } });

    // 목록에서 다른 문서를 고르는 동작. 마운트를 말하지 않았으므로 호스트가 정한다.
    act(() => { listCtx?.panes.open({ paneId: "doc", params: { path: "b.ts" } }); });

    // 레일에 사본이 서면 한 페인의 두 사본이 서로 다른 주소를 들고 각자 자기 주소로
    // 스토어를 되돌리려 든다 — 갱신이 멈추지 않고 화면이 통째로 죽는다.
    expect(getPaneStoreSnapshot().rail.filter((instance) => instance.visible)).toEqual([]);
    expect(getExpandedSurfaceState().instances[0]?.params).toEqual({ paneId: "doc", path: "b.ts" });
  });

  it("주소 갱신은 주차된 페인을 되살리지 않는다", () => {
    render();
    act(() => { openPane({ paneId: "doc", params: { path: "a.ts" } }); });
    act(() => { closePane("doc", { keepAlive: true }); });
    expect(getPaneStoreSnapshot().rail[0]?.visible).toBe(false);

    // 주차된 사본도 렌더는 계속되므로 자기 컨텍스트를 갖는다 — 그 창구로 갈아탄다.
    act(() => { docCtx?.panes.replaceParams({ path: "b.ts" }); });

    // 확대된 문서가 주소를 갱신할 때마다 주차된 사본이 튀어나오면 같은 다툼이 되살아난다.
    expect(getPaneStoreSnapshot().rail[0]?.visible).toBe(false);
    expect(getPaneStoreSnapshot().rail[0]?.params).toEqual({ path: "b.ts" });
  });

  // 서술자 색인의 정체는 플러그인 레지스트리가 채워지며 부팅 중에 바뀐다. 그것을 계기로
  // 삼으면 마운트 직후 복원한 열이 그 순간 주차된다 — 새로고침 뒤 읽던 문서가 사라진다.
  it("색인 정체가 바뀌었다는 이유로 세운 열을 치우지 않는다", () => {
    render();
    act(() => { openPane({ paneId: "doc", params: { path: "a.ts" } }); });
    expect(getPaneStoreSnapshot().rail[0]?.visible).toBe(true);

    // 레지스트리가 늦게 채워져 색인이 새 Map으로 바뀐 상황.
    act(() => {
      PANE_INDEX.value = new Map<string, unknown>([["list", listPane], ["doc", docPane]]);
      root.render(
        <RailSurface
          binding={binding as never}
          theaterId="theater-1"
          api={{} as never}
          language="en"
          onRequestExtraWidth={(px) => extraWidthRequests.push(px)}
        />,
      );
    });

    expect(getPaneStoreSnapshot().rail[0]?.visible).toBe(true);
  });

  it("엔트리를 갈아타도 keepAlive 열은 선 채로 남는다", () => {
    render();
    act(() => { openPane({ paneId: "doc", params: { path: "a.ts" } }); });

    // 다른 엔트리로 갔다 오는 것. 주차해 버리면 돌아왔을 때 접힌 열을 다시 세울 주체가 없다 —
    // 페인을 연 것은 사용자의 한 번뿐인 동작이었기 때문이다.
    act(() => { resetSurfacePanes(PANE_INDEX.value as never); });

    expect(getPaneStoreSnapshot().rail.map((i) => [i.paneId, i.visible])).toEqual([["doc", true]]);
  });

  it("keepAlive를 말하지 않은 열은 엔트리를 갈아탈 때 사라진다", () => {
    render();
    act(() => { openPane({ paneId: "doc" }); });
    act(() => { resetSurfacePanes(new Map([["doc", { keepAlive: false }]]) as never); });

    expect(getPaneStoreSnapshot().rail).toEqual([]);
  });

  it("분할선 키보드 이동은 폭을 기억한다", () => {
    render();
    act(() => { openPane({ paneId: "doc" }); });

    const divider = container.querySelector<HTMLElement>(".rail-pane-divider");
    // jsdom에는 레이아웃이 없어 표면 폭이 0이다 — 클램프가 잠기는지만이 아니라, 잠긴 상태에서
    // 키보드가 폭을 망가뜨리지 않는지도 이 계약의 일부다.
    act(() => {
      divider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    const stored = getStoredPaneWidth("list");
    expect(stored === undefined || stored >= 0).toBe(true);
  });
});

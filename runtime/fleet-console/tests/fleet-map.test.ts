// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FleetMap } from "../core/client/src/canvas/fleet-map.js";
import {
  anchorViewportToPoint,
  resolveFleetMapZoomAnchor,
  FLEET_MAP_ENTER_ZOOM,
  FLEET_MAP_EXIT_ZOOM,
  resolveFleetContentCenter,
  resolveFleetMapActive,
  resolveFleetMapDriftStyle,
  resolveFleetMapMarkerLayout,
  resolveFleetMapZoneLayout,
} from "../core/client/src/canvas/fleet-map-layout.js";
import { markIdleArrival, resetIdleArrivalForTests } from "../core/client/src/operation-marks.js";
import type { OperationNode } from "../core/client/src/types.js";

const THEATERS = [
  { id: "theater-a", label: "Alpha" },
  { id: "theater-b", label: "Beta" },
];

describe("fleet map activation", () => {
  it("enters below 0.2 and leaves above 0.24 — a wheel notch on the edge never flips the plate twice", () => {
    expect(FLEET_MAP_ENTER_ZOOM).toBeLessThan(FLEET_MAP_EXIT_ZOOM);
    // 두 임계 모두 focusOperation의 줌 하한(0.25) 아래다 — 어떤 포커스 점프도 지도를 벗어난다.
    expect(FLEET_MAP_EXIT_ZOOM).toBeLessThan(0.25);
    expect(resolveFleetMapActive(false, 1)).toBe(false);
    expect(resolveFleetMapActive(false, 0.2)).toBe(false);
    expect(resolveFleetMapActive(false, 0.19)).toBe(true);
    // 진입 후에는 이탈 임계까지 붙어 있다.
    expect(resolveFleetMapActive(true, 0.22)).toBe(true);
    expect(resolveFleetMapActive(true, 0.24)).toBe(true);
    expect(resolveFleetMapActive(true, 0.25)).toBe(false);
    // 이탈 뒤 같은 배율은 다시 진입하지 않는다.
    expect(resolveFleetMapActive(false, 0.22)).toBe(false);
    expect(resolveFleetMapActive(true, Number.NaN)).toBe(false);
  });

  it("anchors zoom on the visible fleet's center so the panels come back on screen", () => {
    // 판 위의 커서는 월드와 무관하다 — 판에서의 줌은 함대 중심을 아레나 중앙에 놓는다.
    const center = resolveFleetContentCenter({
      a: { x: 0, y: 0, width: 400, height: 200, zIndex: 1 },
      b: { x: 800, y: 600, width: 400, height: 200, zIndex: 2 },
      hidden: { x: 9000, y: 9000, width: 400, height: 200, zIndex: 3 },
    }, ["hidden"]);
    expect(center).toEqual({ x: 600, y: 400 });
    expect(resolveFleetContentCenter({}, [])).toBeNull();
    expect(resolveFleetContentCenter({ only: { x: 10, y: 10, width: 100, height: 100, zIndex: 1 } }, ["only"])).toBeNull();
    const viewport = anchorViewportToPoint({ x: 600, y: 400 }, 0.5, { width: 1000, height: 800 });
    // 월드 (600,400)이 화면 (500,400)에 온다: 500 - 600*0.5 = 200, 400 - 400*0.5 = 200.
    expect(viewport).toEqual({ x: 200, y: 200, zoom: 0.5 });
    // 화면 점을 주면 그 점 아래에 온다 — 판에서 겨눈 자리로 내려가는 앵커.
    expect(anchorViewportToPoint({ x: 600, y: 400 }, 0.5, { width: 1000, height: 800 }, { x: 900, y: 700 })).toEqual({ x: 600, y: 500, zoom: 0.5 });
  });

  it("zooms toward the dot nearest the cursor, or nowhere when the active theater has none", () => {
    const near = { operationId: "near", screen: { x: 100, y: 100 }, center: { x: 10, y: 10 } };
    const far = { operationId: "far", screen: { x: 900, y: 700 }, center: { x: 5000, y: 5000 } };
    expect(resolveFleetMapZoomAnchor([far, near], { x: 130, y: 90 })).toBe(near);
    expect(resolveFleetMapZoomAnchor([far, near], { x: 880, y: 720 })).toBe(far);
    expect(resolveFleetMapZoomAnchor([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("fleet map zone layout", () => {
  it("separates fleet zones until none overlap at the given aspect", () => {
    // 9개 이상이면 슬롯이 재사용되어 동일 중심에서 출발한다 — 분리 반복이 결정적 방향으로
    // 밀어내 그 퇴화 케이스까지 겹침 없이 정착해야 한다.
    const zones = resolveFleetMapZoneLayout(
      Array.from({ length: 9 }, (_, index) => ({ theaterId: `t${index}`, count: 2 })),
      1.6,
    );
    // 픽셀 겹침 판정은 높이=100 정규 좌표계에서 수행한다(size는 높이 기준 지름).
    const width = 100 * 1.6;
    const points = zones.map((zone) => ({
      x: (zone.centerX / 100) * width,
      y: zone.centerY,
      r: zone.size / 2,
    }));
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dist = Math.hypot(points[j]!.x - points[i]!.x, points[j]!.y - points[i]!.y);
        expect(dist).toBeGreaterThanOrEqual(points[i]!.r + points[j]!.r);
      }
    }
  });

  it("keeps a theater's zone on its own slot when input order changes", () => {
    // 자리는 Theater 정체성(slotIndex)에 묶인다 — 입력 순서가 바뀌어도 구역이 자리를 맞바꾸지 않는다.
    const first = resolveFleetMapZoneLayout([
      { theaterId: "alpha", count: 3, slotIndex: 0 },
      { theaterId: "bravo", count: 3, slotIndex: 1 },
    ], 1.6);
    const reordered = resolveFleetMapZoneLayout([
      { theaterId: "bravo", count: 3, slotIndex: 1 },
      { theaterId: "alpha", count: 3, slotIndex: 0 },
    ], 1.6);
    const find = (zones: readonly { theaterId: string; centerX: number; centerY: number }[], id: string) =>
      zones.find((zone) => zone.theaterId === id)!;
    expect(find(reordered, "alpha").centerX).toBeCloseTo(find(first, "alpha").centerX, 6);
    expect(find(reordered, "alpha").centerY).toBeCloseTo(find(first, "alpha").centerY, 6);
    expect(find(reordered, "bravo").centerX).toBeCloseTo(find(first, "bravo").centerX, 6);
    expect(find(reordered, "bravo").centerY).toBeCloseTo(find(first, "bravo").centerY, 6);
  });

  it("lays fleet zones on deterministic slots with sqrt-of-count sizing", () => {
    const zones = resolveFleetMapZoneLayout([
      { theaterId: "big", count: 9 },
      { theaterId: "small", count: 1 },
    ]);
    const again = resolveFleetMapZoneLayout([
      { theaterId: "big", count: 9 },
      { theaterId: "small", count: 1 },
    ]);
    // 결정적 배치 — 같은 입력이면 같은 자리·크기(렌더마다 흔들리면 지도가 아니다).
    expect(zones).toEqual(again);
    expect(new Set(zones.map((zone) => `${zone.centerX}:${zone.centerY}`)).size).toBe(2);
    expect(zones[0]!.size).toBeGreaterThan(zones[1]!.size);
    for (const zone of zones) {
      expect(zone.size).toBeGreaterThanOrEqual(34);
      expect(zone.size).toBeLessThanOrEqual(66);
    }
  });
});

describe("fleet map marker layout", () => {
  const geometry = (x: number, y: number) => ({ x, y, width: 100, height: 60, zIndex: 1 });
  const expectInBounds = (layout: ReturnType<typeof resolveFleetMapMarkerLayout>) => {
    for (const marker of layout) {
      expect(marker.x).toBeGreaterThanOrEqual(4);
      expect(marker.x).toBeLessThanOrEqual(96);
      expect(marker.y).toBeGreaterThanOrEqual(4);
      expect(marker.y).toBeLessThanOrEqual(96);
    }
  };
  const minimumPairwiseDistance = (layout: ReturnType<typeof resolveFleetMapMarkerLayout>) => {
    let minimum = Number.POSITIVE_INFINITY;
    for (let left = 0; left < layout.length; left += 1) {
      for (let right = left + 1; right < layout.length; right += 1) {
        const a = layout[left]!;
        const b = layout[right]!;
        minimum = Math.min(minimum, Math.hypot(b.x - a.x, b.y - a.y));
      }
    }
    return minimum;
  };

  it("projects non-collinear canvas geometry centers into the [8%,92%]×[10%,86%] field", () => {
    const layout = resolveFleetMapMarkerLayout([
      { id: "a", geometry: geometry(0, 0) },
      { id: "b", geometry: geometry(900, 400) },
      { id: "c", geometry: geometry(0, 400) },
    ]);
    expect(layout.find((marker) => marker.operationId === "a")).toMatchObject({ x: 8, y: 10 });
    expect(layout.find((marker) => marker.operationId === "b")).toMatchObject({ x: 92, y: 86 });
  });

  it("scatters a two-operation degenerate axis deterministically across the field", () => {
    const input = [
      { id: "a", geometry: geometry(0, 0) },
      { id: "b", geometry: geometry(500, 0) },
    ];
    const first = resolveFleetMapMarkerLayout(input);
    const second = resolveFleetMapMarkerLayout(input);
    expect(first).toEqual(second);
    expectInBounds(first);
    expect(first.every((marker) => marker.y === 48)).toBe(false);
  });

  it("places geometry-less operations deterministically without Math.random", () => {
    const input = [
      { id: "orphan-1", geometry: null },
      { id: "orphan-2", geometry: null },
      { id: "orphan-3", geometry: null },
    ];
    const first = resolveFleetMapMarkerLayout(input);
    const second = resolveFleetMapMarkerLayout([...input].reverse());
    // 반환 순서는 입력 순서를 따르므로 id 기준 정렬 후 비교 — 위치 자체가 결정적이어야 한다.
    const byId = (layout: typeof first) => [...layout].sort((a, b) => a.operationId.localeCompare(b.operationId));
    expect(byId(first)).toEqual(byId(second));
    expectInBounds(first);
  });

  it("projects geometry and scatters geometry-less operations together deterministically", () => {
    const input = [
      { id: "corner-a", geometry: geometry(0, 0) },
      { id: "corner-b", geometry: geometry(900, 400) },
      { id: "corner-c", geometry: geometry(0, 400) },
      { id: "orphan-wide-17", geometry: null },
      { id: "orphan-wide-83", geometry: null },
    ];
    const first = resolveFleetMapMarkerLayout(input);
    expect(first).toEqual(resolveFleetMapMarkerLayout(input));
    expect(first.find((marker) => marker.operationId === "corner-a")).toMatchObject({ x: 8, y: 10 });
    expect(first.find((marker) => marker.operationId === "corner-b")).toMatchObject({ x: 92, y: 86 });
    expectInBounds(first);
    expect(minimumPairwiseDistance(first)).toBeGreaterThanOrEqual(3.5);
  });

  it("fans a collinear cascade across the full field", () => {
    const ids = ["alpha-17", "bravo-43", "charlie-89", "delta-131", "echo-211", "foxtrot-307", "golf-419", "hotel-557"];
    const input = ids.map((id, index) => ({ id, geometry: geometry(index * 24, index * 24) }));
    const layout = resolveFleetMapMarkerLayout(input);
    const xs = layout.map((marker) => marker.x);
    const ys = layout.map((marker) => marker.y);
    expect(layout).toEqual(resolveFleetMapMarkerLayout(input));
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(40);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(30);
    // 스팬만으로는 대각선 투영도 통과한다 — 산포가 실제로 일어났음은 투영 직선 이탈로 고정한다.
    expect(layout.some((marker) => Math.abs((marker.y - 10) - (marker.x - 8) * (76 / 84)) > 5)).toBe(true);
  });

  it("relaxes overlapping markers apart deterministically", () => {
    // 같은 중심의 geometry 3개 — 퇴화 산포와 이완 후 쌍 거리는 최소 4%를 만족한다.
    const input = [
      { id: "a", geometry: geometry(100, 100) },
      { id: "b", geometry: geometry(100, 100) },
      { id: "c", geometry: geometry(100, 100) },
    ];
    const layout = resolveFleetMapMarkerLayout(input);
    expect(layout).toEqual(resolveFleetMapMarkerLayout(input));
    expect(minimumPairwiseDistance(layout)).toBeGreaterThanOrEqual(4 - 1e-6);
  });

  it("keeps drift deterministic per id and narrows amplitude for non-running dots", () => {
    const active = resolveFleetMapDriftStyle("alpha-map", true) as Record<string, string>;
    const calm = resolveFleetMapDriftStyle("alpha-map", false) as Record<string, string>;
    // 같은 id는 언제나 같은 경로를 받는다 — 렌더마다 흔들리면 지도가 아니다.
    expect(resolveFleetMapDriftStyle("alpha-map", true)).toEqual(active);
    // 상태 위계는 진폭과 주기가 만든다: 비실행은 더 좁게, 더 느리게 돈다.
    const amplitude = (style: Record<string, string>) => Math.abs(Number.parseFloat(style["--fleet-drift-x1"]!));
    expect(amplitude(calm)).toBeLessThan(amplitude(active));
    expect(Number.parseFloat(calm["--fleet-drift-mult"]!)).toBeGreaterThan(Number.parseFloat(active["--fleet-drift-mult"]!));
  });
});

describe("FleetMap", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetIdleArrivalForTests();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    resetIdleArrivalForTests();
  });

  const render = (props: Partial<Parameters<typeof FleetMap>[0]> = {}) => {
    const operations = props.operations ?? [operation("alpha-map", "theater-a"), operation("beta-map", "theater-b")];
    act(() => {
      root?.render(createElement(FleetMap, {
        theaters: THEATERS,
        operationRuntime: {},
        activeTheaterId: "theater-a",
        aspect: 1.8,
        leaving: false,
        geometryFor: (candidate) => candidate.geometry,
        onPick: () => {},
        ...props,
        operations,
      }));
    });
  };

  it("stands one zone per populated theater, marks the active one, and injects drift on every dot", () => {
    render({
      operationRuntime: { "alpha-map": { lifecycle: "live", activity: "running" }, "beta-map": { lifecycle: "live", activity: "awaiting" } },
    });
    expect(container!.querySelectorAll(".canvas-fleet-map-zone")).toHaveLength(2);
    expect(container!.querySelector('[data-fleet-map-zone="theater-a"]')?.classList.contains("is-active")).toBe(true);
    expect(container!.querySelector('[data-fleet-map-zone="theater-b"]')?.classList.contains("is-active")).toBe(false);
    const dots = [...container!.querySelectorAll<HTMLElement>("[data-fleet-map-dot]")];
    expect(dots).toHaveLength(2);
    // 점은 캔버스 제스처의 대상이 아니다 — 판 바닥(팬·휠)과 달리 여기서 시작한 포인터는 막힌다.
    expect(dots.every((dot) => dot.hasAttribute("data-canvas-blocker"))).toBe(true);
    const running = container!.querySelector<HTMLElement>('[data-fleet-map-dot="alpha-map"]');
    const awaiting = container!.querySelector<HTMLElement>('[data-fleet-map-dot="beta-map"]');
    expect(running?.classList.contains("is-running")).toBe(true);
    expect(awaiting?.classList.contains("is-awaiting")).toBe(true);
    // 모든 마커가 결정적 유영 변수를 주입받는다 — 정지한 점은 죽은 표시로 읽힌다.
    expect(running?.style.getPropertyValue("--fleet-drift-mult")).not.toBe("");
    expect(running?.style.getPropertyValue("--fleet-drift-x1")).toMatch(/px$/);
    expect(awaiting?.style.getPropertyValue("--fleet-drift-mult")).not.toBe("");
    // 구역 표석은 소속 수를 말한다.
    expect(container!.querySelector('[data-fleet-map-zone="theater-b"] .canvas-fleet-map-zone-counts')?.textContent).toBe("1 operations");
  });

  it("uses the whole plate for a single theater and keeps dormant operations on the map", () => {
    render({
      theaters: [THEATERS[0]!],
      operations: [operation("solo-a", "theater-a"), operation("solo-b", "theater-a")],
    });
    // 등록 Theater 자체가 하나면 구역을 나눌 이유가 없다 — 원 없이 판 전체가 그 함대의 바다다.
    expect(container!.querySelectorAll(".canvas-fleet-map-zone")).toHaveLength(0);
    expect(container!.querySelector(".canvas-fleet-map-field.is-plane")).not.toBeNull();
    // 런타임 항목이 없는 Operation도 점으로 선다 — 지도는 활동으로 거르지 않는다(Cruise는 휴면
    // 패널까지 그리는 모드다). 복원 마커 없는 무런타임은 활동 축 폴백대로 유휴다.
    const dots = [...container!.querySelectorAll<HTMLElement>("[data-fleet-map-dot]")];
    expect(dots).toHaveLength(2);
    expect(dots.every((dot) => dot.classList.contains("is-idle"))).toBe(true);
  });

  it("classifies an idle arrival as an unseen marker, distinct from a genuine awaiting one", () => {
    const arrival = operation("arrival-map", "theater-a");
    markIdleArrival(arrival.id);
    render({ operations: [arrival], operationRuntime: { "arrival-map": { lifecycle: "live", activity: "idle" } } });
    // 유휴 도착은 지도에서도 사이드바 칩·커맨드 밴드와 같은 마크 축을 쓴다 — 진짜 대기(aurora)와
    // 구별되는 미확인 마커(초록 느린 점등)여야 한다.
    const dot = container!.querySelector<HTMLElement>('[data-fleet-map-dot="arrival-map"]');
    expect(dot?.classList.contains("is-unseen")).toBe(true);
    expect(dot?.classList.contains("is-awaiting")).toBe(false);
    expect(dot?.classList.contains("is-idle")).toBe(false);
  });

  it("picks an operation on click and routes context menus to the operation or its theater", () => {
    const onPick = vi.fn();
    const onOperationContextMenu = vi.fn();
    const onTheaterContextMenu = vi.fn();
    render({ onPick, onOperationContextMenu, onTheaterContextMenu });
    const dot = container!.querySelector<HTMLButtonElement>('[data-fleet-map-dot="beta-map"]')!;
    act(() => { dot.click(); });
    expect(onPick).toHaveBeenCalledWith("beta-map");

    const dotMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 91, clientY: 102 });
    act(() => { dot.dispatchEvent(dotMenu); });
    expect(dotMenu.defaultPrevented).toBe(true);
    expect(onOperationContextMenu).toHaveBeenLastCalledWith("beta-map", expect.any(DOMRect), dot);
    // 점의 메뉴는 구역까지 올라가지 않는다 — 한 우클릭에 메뉴 하나.
    expect(onTheaterContextMenu).not.toHaveBeenCalled();

    const zone = container!.querySelector<HTMLElement>('[data-fleet-map-zone="theater-b"] .canvas-fleet-map-field')!;
    const zoneMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 71, clientY: 82 });
    act(() => { zone.dispatchEvent(zoneMenu); });
    expect(zoneMenu.defaultPrevented).toBe(true);
    expect(onTheaterContextMenu).toHaveBeenCalledWith("theater-b", { x: 71, y: 82 });
  });

  it("keeps a nameplate when the only populated Theater is foreign to the active one", () => {
    // 등록된 Theater는 둘이지만 활성 Theater의 패널은 모두 최소화되어 외부 Theater 하나만 지도에
    // 남을 수 있다. 이는 단일 Theater 제품이 아니므로 평면으로 익명화하지 않고 표석을 남겨야 한다.
    render({
      operations: [operation("foreign-only", "theater-b")],
      activeTheaterId: "theater-a",
    });
    expect(container!.querySelector(".canvas-fleet-map-field.is-plane")).toBeNull();
    expect(container!.querySelector('[data-fleet-map-zone-pick="theater-b"]')).not.toBeNull();
  });

  it("turns each zone's nameplate into a door to that theater", () => {
    const onSelectTheater = vi.fn();
    render({ onSelectTheater });
    const picks = [...container!.querySelectorAll<HTMLButtonElement>("[data-fleet-map-zone-pick]")];
    expect(picks).toHaveLength(2);
    // 표석도 점처럼 캔버스 제스처에서 제외된다 — 누르는 순간 팬이 시작되면 안 된다.
    expect(picks.every((pick) => pick.hasAttribute("data-canvas-blocker"))).toBe(true);
    const active = container!.querySelector<HTMLButtonElement>('[data-fleet-map-zone-pick="theater-a"]')!;
    const other = container!.querySelector<HTMLButtonElement>('[data-fleet-map-zone-pick="theater-b"]')!;
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(other.getAttribute("aria-pressed")).toBe("false");
    act(() => { other.click(); });
    expect(onSelectTheater).toHaveBeenCalledWith("theater-b");
  });

  it("takes its dots out of the tab order while leaving", () => {
    render({ leaving: true });
    const map = container!.querySelector<HTMLElement>(".canvas-fleet-map");
    expect(map?.classList.contains("is-leaving")).toBe(true);
    expect(map?.getAttribute("aria-hidden")).toBe("true");
    const dots = [...container!.querySelectorAll<HTMLButtonElement>("[data-fleet-map-dot], [data-fleet-map-zone-pick]")];
    expect(dots.every((dot) => dot.tabIndex === -1)).toBe(true);
  });
});

function operation(id: string, theaterId: string): OperationNode {
  return {
    id,
    theaterId,
    type: "agent",
    pluginId: "terminal",
    title: id,
    payload: {},
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  };
}

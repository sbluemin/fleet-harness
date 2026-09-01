// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const railPanelContextMock = vi.hoisted(() => ({ themes: [] as unknown[], renderCount: 0, activate: vi.fn(), repoNotesOnClose: vi.fn() }));
const BINDING_CACHE = vi.hoisted(() => ({ value: null as unknown }));
const PANE_INDEX_CACHE = vi.hoisted(() => ({ value: null as unknown }));

const CORE_PANELS: Record<string, unknown>[] = [
  {
    id: "repository",
    title: "REPOSITORY",
    defaultWidth: 360,
    icon: "P",
    // 교체 정리 계약을 재는 detail 짝 — keepAlive 없는 열과 keepAlive 열을 하나씩 둔다.
    details: [
      { id: "repo-notes", title: "NOTES", onClose: railPanelContextMock.repoNotesOnClose },
      { id: "repo-term", title: "TERM", keepAlive: true },
    ],
    render: (ctx: { readonly theme?: unknown }) => {
      railPanelContextMock.renderCount += 1;
      railPanelContextMock.themes.push(ctx.theme);
      return <button className="test-panel-action">Panel action</button>;
    },
  },
  {
    id: "codex",
    title: "CODEX",
    defaultWidth: 420,
    icon: "C",
    render: () => null,
  },
  {
    id: "alerts",
    title: "ALERTS",
    icon: "A",
    render: () => null,
  },
  {
    // 설정 표면 — 실제 레지스트리처럼 코어 엔트리로 선다. 문(톱니)만이 이 엔트리를 연다.
    id: "settings",
    title: "SETTINGS",
    icon: "G",
    render: () => null,
  },
];

/* 페인 엔트리 사이에 동작 엔트리를 끼워 둔다 — 프로덕션의 Codex(페인)·Shell(동작) 이웃처럼,
   합성 순서가 렌더에서 종류별로 뒤집히지 않는다는 계약을 이 배열 순서가 검증한다. */
const PLUGIN_FIXTURES: Record<string, unknown>[] = [
  {
    id: "file-explorer",
    title: "FILES",
    icon: "F",
    // 마운트 효과에서 자기 확장 폭을 요구하는 본문 — 자식 효과가 부모(RailSurface) 효과보다
    // 먼저 도는 실제 순서를 재현한다(Codex P2 판별 픽스처).
    render: () => <FilesMountExtra />,
  },
  {
    id: "shell-action",
    title: "SHELL",
    icon: "H",
    surfaceId: "shell",
    activate: railPanelContextMock.activate,
  },
  {
    id: "plain-action",
    title: "PLAIN",
    icon: "N",
    activate: () => undefined,
  },
  {
    id: "ledger",
    title: "LEDGER",
    icon: "L",
    // 마운트 효과에서 자기 detail을 여는 본문 — 팔레트 착지 직후의 파일 문서 열, Codex 리더가
    // 실제로 하는 일이다(Codex 3차 P1 판별 픽스처).
    details: [{ id: "ledger-doc", title: "DOC" }],
    render: () => <LedgerMountDetail />,
  },
];

// 새 계약의 레지스트리를 모킹한다. 여기 적는 것은 여전히 "옛 패널 모양"이고, 아래 helper가
// 그것을 엔트리+페인 바인딩으로 편다 — 프로덕션의 투영과 같은 규칙이라, 이 테스트는 투영
// 경로도 함께 지킨다(#957 상류 테스트와 같은 문법).
function toBinding(panel: Record<string, unknown>, core: boolean) {
  const hasBody = typeof panel.render === "function";
  const details = Array.isArray(panel.details) ? panel.details as readonly Record<string, unknown>[] : [];
  return {
    entry: {
      id: panel.id,
      title: panel.title,
      icon: panel.icon,
      ...(panel.surfaceId === undefined ? {} : { surfaceId: panel.surfaceId }),
      ...(hasBody ? { panes: [panel.id, ...details.map((detail) => detail.id)] } : { activate: panel.activate }),
    },
    panes: hasBody
      ? [{
        id: panel.id,
        role: "primary",
        mounts: ["rail"],
        title: () => panel.title,
        render: panel.render,
        ...(panel.defaultWidth === undefined ? {} : { defaultWidth: panel.defaultWidth }),
      }, ...details.map((detail) => ({
        id: detail.id,
        role: "detail",
        mounts: ["rail"],
        title: () => detail.title,
        render: () => null,
        ...(detail.keepAlive === true ? { keepAlive: true } : {}),
        ...(typeof detail.onClose === "function" ? { onClose: detail.onClose } : {}),
      }))]
      : [],
    projected: true,
    core,
  };
}

function buildBindings() {
  return [
    ...CORE_PANELS.map((panel) => toBinding(panel, true)),
    ...PLUGIN_FIXTURES.map((panel) => toBinding(panel, false)),
  ];
}

vi.mock("../core/client/src/pane/pane-registry.js", () => ({
  // 프로덕션 useRailEntries는 useMemo라 참조가 안정적이다 — 여기서도 한 번만 만든다.
  useRailEntries: () => (BINDING_CACHE.value ??= buildBindings()),
  usePaneIndex: () => (PANE_INDEX_CACHE.value ??= new Map(
    (BINDING_CACHE.value ??= buildBindings())
      .flatMap((binding: { panes: { id: string }[] }) => binding.panes.map((pane) => [pane.id, pane])),
  )),
}));

import { RightRail } from "../core/client/src/rail/right-rail.js";
import {
  closeRailPanel,
  getRailStoreSnapshot,
  openRailPanel,
  requestRailPanelExtraWidth,
  setRailChromeExpanded,
  setRailOverlayAlpha,
} from "../core/client/src/rail/rail-store.js";

function FilesMountExtra() {
  useEffect(() => {
    requestRailPanelExtraWidth("file-explorer", 360);
  }, []);
  return null;
}

function LedgerMountDetail() {
  useEffect(() => {
    openPane({ paneId: "ledger-doc", mount: "rail", params: { path: "doc.md" } });
  }, []);
  return null;
}
import {
  closeExpandedSurfacesOf,
  openExpandedSurface,
  resetExpandedSurfacesForTest,
} from "../core/client/src/expanded-surface/store.js";
import { __resetPaneStoreForTests, getPaneStoreSnapshot, openPane } from "../core/client/src/pane/pane-store.js";
import { setState } from "../core/client/src/store.js";

let container: HTMLDivElement;
let root: Root;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* 스토어는 모듈 싱글턴이다 — 파일 안에서 테스트끼리 새지 않게 공개 API로만 초기화한다. */
function resetRailStore() {
  const active = getRailStoreSnapshot().activePanelId;
  if (active !== null) closeRailPanel(active);
  setRailChromeExpanded(true);
  setRailOverlayAlpha(100);
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  window.localStorage.clear();
  resetRailStore();
  openRailPanel("repository");
  railPanelContextMock.themes.length = 0;
  railPanelContextMock.renderCount = 0;
  railPanelContextMock.activate.mockClear();
  railPanelContextMock.repoNotesOnClose.mockClear();
  setState({ connection: "live", connectionLostAt: null, activeTheme: "instrument" });
  resetExpandedSurfacesForTest();
  __resetPaneStoreForTests();
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderRail() {
  act(() => root.render(<RightRail theaterId="theater-1" api={{} as never} />));
}

function panelSlot(): HTMLElement {
  const slot = container.querySelector<HTMLElement>(".right-rail-panel-slot");
  if (!slot) throw new Error("panel slot missing");
  return slot;
}

function railRoot(): HTMLElement {
  const rail = container.querySelector<HTMLElement>(".right-rail");
  if (!rail) throw new Error("rail root missing");
  return rail;
}

function sectionOf(title: string): HTMLElement {
  const section = [...container.querySelectorAll<HTMLElement>(".right-rail-section")]
    .find((candidate) => candidate.querySelector(".right-rail-section-title")?.textContent === title);
  if (!section) throw new Error(`section ${title} missing`);
  return section;
}

function iconButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".right-rail-ico")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!button) throw new Error(`icon ${label} missing`);
  return button;
}

function gearButton(): HTMLButtonElement {
  const gear = container.querySelector<HTMLButtonElement>(".right-rail-settings-btn");
  if (!gear) throw new Error("settings gear missing");
  return gear;
}

describe("Right Rail exclusive panel", () => {
  it("renders only the active panel's section — opening another replaces it", () => {
    act(() => openRailPanel("codex"));
    renderRail();

    const titles = [...container.querySelectorAll(".right-rail-section-title")].map((el) => el.textContent);
    expect(titles).toEqual(["CODEX"]);
    expect(railRoot().classList.contains("is-open")).toBe(true);
  });

  it("carries no collapse affordance — the body stands visible with the panel", () => {
    renderRail();
    expect(railPanelContextMock.renderCount).toBeGreaterThan(0);
    expect(container.querySelector(".right-rail-section-toggle")).toBeNull();
    expect(container.querySelector(".right-rail-section-caret")).toBeNull();
    const body = sectionOf("REPOSITORY").querySelector<HTMLElement>(".right-rail-section-body");
    expect(body?.hidden).toBe(false);
    expect(body?.querySelector(".test-panel-action")).not.toBeNull();
  });

  it("closes the section from its header", () => {
    act(() => openRailPanel("codex"));
    renderRail();

    const close = sectionOf("CODEX").querySelector<HTMLButtonElement>(".right-rail-section-close");
    act(() => close!.click());

    expect(getRailStoreSnapshot().activePanelId).toBeNull();
    expect(container.querySelector(".right-rail-section")).toBeNull();
  });

  it("moves focus to the rail icon before a focused close button unmounts its section", () => {
    // 포커스를 쥔 닫기 버튼이 언마운트되면 포커스가 body로 떨어진다 — 아이콘 이관 계약(Codex 리뷰).
    renderRail();
    const close = sectionOf("REPOSITORY").querySelector<HTMLButtonElement>(".right-rail-section-close");
    act(() => { close!.focus(); close!.click(); });
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
    expect(document.activeElement).toBe(iconButton("REPOSITORY"));
  });

  it("drops the leaving panel's non-keepAlive detail on switch — the departing sweep closes it", () => {
    renderRail();
    act(() => openPane({ paneId: "repo-notes", mount: "rail", params: { path: "a.md" } }));
    expect(getPaneStoreSnapshot().rail.some((instance) => instance.paneId === "repo-notes")).toBe(true);

    act(() => iconButton("CODEX").click());

    // 떠나는 표면이 언마운트 cleanup에서 자기 비-keepAlive detail을 닫는다 — 남기면 돌아왔을 때
    // 옛 params째 되살아난다(닫기=언마운트 계약, Codex 1차 P1).
    expect(getPaneStoreSnapshot().rail.some((instance) => instance.paneId === "repo-notes")).toBe(false);
    // 호스트가 닫는 모든 경로는 onClose를 통보한다(sdk/pane 계약) — 통보가 없으면 플러그인이
    // 다음 상태 발행에서 닫힌 문서를 되살린다(Codex 4차 P2).
    expect(railPanelContextMock.repoNotesOnClose).toHaveBeenCalledWith({ paneId: "repo-notes", params: { path: "a.md" } });
  });

  it("leaves the leaving panel's keepAlive detail standing so it returns on reopen", () => {
    renderRail();
    act(() => openPane({ paneId: "repo-term", mount: "rail" }));

    act(() => iconButton("CODEX").click());

    // keepAlive는 PTY·읽던 자리의 계약이다 — 떠나도 스토어에 세워 둔 채 두어야 돌아왔을 때
    // 그 자리가 다시 선다(구 unpin/re-pin 계약 승계). 화면에는 서지 않는다: 도착 표면의
    // owned 필터가 남의 페인을 걸러 낸다.
    const kept = getPaneStoreSnapshot().rail.find((instance) => instance.paneId === "repo-term");
    expect(kept?.visible).toBe(true);
    expect([...container.querySelectorAll(".right-rail-section-title")].map((el) => el.textContent)).toEqual(["CODEX"]);
  });

  it("keeps a detail the arriving panel opens during its own mount", () => {
    renderRail();
    act(() => openPane({ paneId: "repo-notes", mount: "rail" }));

    act(() => iconButton("LEDGER").click());

    // 도착 본문은 마운트 효과에서 자기 detail을 연다(파일 문서 열·Codex 리더). 떠나는 표면의
    // 정리가 도착 마운트 **뒤에** 도는 구조라면 방금 연 이 열이 쓸려 나간다(Codex 3차 P1) —
    // key 재마운트 + 언마운트 cleanup은 정리를 도착보다 먼저 돌게 만든다.
    const doc = getPaneStoreSnapshot().rail.find((instance) => instance.paneId === "ledger-doc");
    expect(doc?.visible).toBe(true);
    expect(getPaneStoreSnapshot().rail.some((instance) => instance.paneId === "repo-notes")).toBe(false);
  });

  it("keeps the arriving panel's mount-time extra-width request across the swap", () => {
    renderRail();
    // repository의 detail이 서서 표면이 확장 폭을 소유한 상태에서 교체한다.
    act(() => openPane({ paneId: "repo-notes", mount: "rail" }));
    expect(getRailStoreSnapshot().panelExtraWidth).toBeGreaterThan(0);

    act(() => iconButton("FILES").click());

    // 이전 표면의 소유권이 살아남으면 standing 0을 본 폭 효과가 도착 패널의 창구로 null을
    // 쏴, 도착 본문이 마운트 효과에서 막 요청한 폭을 덮는다(Codex P2) — 소유권은 엔트리
    // 교체에서 함께 걷혀야 한다.
    expect(getRailStoreSnapshot().panelExtraWidth).toBe(360);
  });

  it("with nothing active the slot closes and the rail loses is-open", () => {
    act(() => closeRailPanel("repository"));
    renderRail();

    expect(railRoot().classList.contains("is-open")).toBe(false);
    expect(container.querySelector(".right-rail-section")).toBeNull();
  });
});

describe("Right Rail icons", () => {
  it("marks only the active panel icon pressed — exclusive grammar", () => {
    act(() => openRailPanel("codex"));
    renderRail();

    expect(iconButton("REPOSITORY").getAttribute("aria-pressed")).toBe("false");
    expect(iconButton("CODEX").getAttribute("aria-pressed")).toBe("true");
    expect(iconButton("ALERTS").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });

  it("icon click replaces the active panel and a second click closes it", () => {
    renderRail();
    act(() => iconButton("CODEX").click());
    expect(getRailStoreSnapshot().activePanelId).toBe("codex");
    act(() => iconButton("CODEX").click());
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
  });
});

describe("Right Rail card width", () => {
  it("uses the active panel's declared default when nothing is stored", () => {
    act(() => openRailPanel("codex"));
    renderRail();
    // 독점 슬롯이라 카드 기본 폭은 활성 패널의 선언값 하나다 — codex 420.
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("420px");
  });

  it("opens every untouched panel at its own declared width", () => {
    // 기억이 없는 도구는 언제나 자기 선언값으로 선다 — 이웃의 폭도, 전체 최댓값도 아니다.
    renderRail();
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("360px");
    act(() => openRailPanel("codex"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("420px");
    act(() => openRailPanel("repository"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("360px");
  });

  it("keeps a resized panel's width off every other panel", () => {
    // 이번 개편의 계약 그 자체 — 한 도구를 넓혀도 나머지는 자기 선언값 그대로 열린다.
    renderRail();
    const handle = container.querySelector<HTMLElement>(".right-rail-resize-handle");
    act(() => {
      handle!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    });
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("424px");

    act(() => openRailPanel("codex"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("420px");

    act(() => openRailPanel("repository"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("424px");
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ repository: 424 });
  });

  it("restores the per-panel width map and drops the retired single-width keys", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 380, codex: 452 }));
    window.localStorage.setItem("fleet-console.rail.cardWidth", "900");
    renderRail();

    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("380px");
    act(() => openRailPanel("codex"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("452px");
    // 도구별 지도가 있으면 카드 단일 값은 주인이 없다 — 남겨 두면 다음 로드가 되심는다.
    expect(window.localStorage.getItem("fleet-console.rail.cardWidth")).toBeNull();
  });

  it("hands the retired card width to the last active panel only", () => {
    // 그 폭은 사용자가 그 도구를 보면서 정한 값이다. 화면에 없던 도구가 물려받을 근거는 없다.
    window.localStorage.setItem("fleet-console.rail.activePanelId", "codex");
    window.localStorage.setItem("fleet-console.rail.cardWidth", "500");
    act(() => openRailPanel("codex"));
    renderRail();

    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("500px");
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ codex: 500 });
    expect(window.localStorage.getItem("fleet-console.rail.cardWidth")).toBeNull();

    act(() => openRailPanel("repository"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("360px");
  });

  it("falls back without crashing for a corrupted stored width", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", "not-json");
    renderRail();
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("360px");
  });

  it("treats a malformed map as absent so the retired card width still lands", () => {
    // v1.79.0의 마이그레이션은 깨진 지도를 만나면 아무것도 못 하고 그대로 뒀다 — 그 뒤 사용자가
    // 폭을 조절했다면 깨진 지도와 멀쩡한 카드 폭이 함께 남는다. 깨진 지도가 그 값을 영원히
    // 가리면 안 되고, 그 지도 자체도 걷혀야 한다.
    window.localStorage.setItem("fleet-console.rail.panelWidths", "{oops");
    window.localStorage.setItem("fleet-console.rail.cardWidth", "500");
    renderRail();

    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("500px");
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ repository: 500 });
    expect(window.localStorage.getItem("fleet-console.rail.cardWidth")).toBeNull();
  });

  it("treats a map with no usable entry as absent so the retired card width still lands", () => {
    // 문법은 멀쩡한데 쓸 수 있는 항목이 하나도 없는 지도는 아무것도 말하지 않는다 — 그것을
    // 권위로 받으면 함께 남은 멀쩡한 단일 폭을 근거 없이 버린다. v1.79.0의 리더는 후보를 하나도
    // 못 찾으면 removeItem 앞에서 조기 반환해 그 지도를 남겼으므로, 이 공존도 실제로 존재한다.
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: "oops" }));
    window.localStorage.setItem("fleet-console.rail.cardWidth", "500");
    renderRail();

    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("500px");
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ repository: 500 });
    expect(window.localStorage.getItem("fleet-console.rail.cardWidth")).toBeNull();
  });

  it("keeps a partly valid map authoritative instead of falling back", () => {
    // 항목 하나라도 쓸 수 있으면 그 지도는 정보를 담고 있다 — 그때는 승계로 되돌아가지 않는다.
    // "쓸 수 있는 항목이 하나라도 있는가"가 경계이고, 이 경계는 더 밀리지 않는다.
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 480, codex: "oops" }));
    window.localStorage.setItem("fleet-console.rail.cardWidth", "500");
    renderRail();

    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("480px");
    act(() => openRailPanel("codex"));
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("420px");
    expect(window.localStorage.getItem("fleet-console.rail.cardWidth")).toBeNull();
  });

  it("saves a drag under the panel that owned the handle, not the one that arrived mid-drag", () => {
    // 드래그는 수백 ms 이상 지속되는 제스처다. 그 사이 플러그인의 `panels.open`이나 라우트
    // 변경이 다른 패널을 세울 수 있고, 그때 끌던 폭이 도착한 패널의 기억으로 새면 안 된다.
    renderRail();
    const handle = container.querySelector<HTMLElement>(".right-rail-resize-handle");
    act(() => {
      handle!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 800 }));
    });
    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 760 }));
    });
    // 끄는 도중 다른 패널이 선다.
    act(() => openRailPanel("codex"));
    act(() => {
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 760 }));
    });

    const stored = JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths") ?? "{}");
    expect(stored).toEqual({ repository: 400 });
    // 도착한 패널은 자기 선언값 그대로다.
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("420px");
  });

  it("keyboard resize persists the width under the active panel's key", () => {
    renderRail();
    const handle = container.querySelector<HTMLElement>(".right-rail-resize-handle");
    expect(handle?.getAttribute("aria-valuenow")).toBe("360");
    act(() => {
      handle!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ repository: 376 });
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("376px");
  });

  it("clamps to the viewport allowance and keeps the ARIA maximum in sync", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
    renderRail();
    const handle = container.querySelector<HTMLElement>(".right-rail-resize-handle");
    // max = innerWidth − 148 − 사이드바 점유(기본 280 + 부유 여백 24) = 248.
    // 두 부유 카드는 같은 층의 절대 배치라, 상한이 사이드바 점유를 빼지 않으면
    // End 키 한 번에 레일이 사이드바를 덮는다(Codex 리뷰 계약).
    expect(handle?.getAttribute("aria-valuemax")).toBe("248");
  });

  it("keeps an over-viewport stored width as the desired target and restores it when the window widens", () => {
    // 좁은 창 로드에서 렌더 폭만 클램프하고 저장 폭은 desired로 남긴다 — init 클램프를
    // desired로 심으면 큰 화면에서 저장한 폭이 재로드 한 번에 소실된다(Codex 리뷰 계약).
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 900 }));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
    renderRail();
    // 1200 − 148 − 304 = 748로 클램프되어 렌더.
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("748px");
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ repository: 900 });

    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
      window.dispatchEvent(new Event("resize"));
    });
    // 1600 − 148 − 304 = 1148 > 900 → 저장 폭 그대로 복원.
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("900px");
  });
});

/* 톱니는 메뉴가 아니라 설정 표면의 문이다 — 옛 컨텍스트 메뉴 계약(플로팅·불투명도·폭·닫기)은
   설정 페인과 직접 조작으로 해체됐고, 여기 남는 것은 문의 계약이다. */
describe("Right Rail settings gear", () => {
  it("stacks the column as window verb, then gear, then a divider before the panel toggles", () => {
    renderRail();
    const children = [...(container.querySelector(".right-rail-icons")?.children ?? [])];
    // 창 동사(접기)는 도구 위, 열 최상단에 선다 — 카드 자신을 다루는 일은 도구보다 먼저다(Periscope).
    expect(children[0]?.matches(".right-rail-collapse")).toBe(true);
    expect(children[1]).toBe(gearButton());
    expect(children[2]?.matches(".right-rail-divider")).toBe(true);
    expect(children[2]?.getAttribute("role")).toBe("separator");
    // 디바이더 다음부터가 패널 토글이다 — 콘솔을 다스리는 일과 패널을 고르는 일의 경계.
    expect(children[3]?.matches(".right-rail-tabs")).toBe(true);
  });

  it("carries no hover-reveal chrome, so the body owns the whole slot", () => {
    renderRail();
    expect(container.querySelector(".right-rail-panel-head-reveal")).toBeNull();
    expect(container.querySelector(".right-rail-panel-peek")).toBeNull();
    expect(panelSlot().querySelector(".right-rail-panel-body")).not.toBeNull();
  });

  it("toggles the settings surface as the active section and speaks pressed + brass", () => {
    renderRail();
    expect(gearButton().getAttribute("aria-pressed")).toBe("false");

    act(() => gearButton().click());

    expect(getRailStoreSnapshot().activePanelId).toBe("settings");
    expect(gearButton().getAttribute("aria-pressed")).toBe("true");
    expect(gearButton().classList.contains("is-active")).toBe(true);
    // 문은 표면을 그대로 연다 — 섹션 본문은 문(토글)을 라벨로 삼는 region으로 서고,
    // 문은 자기 표면을 가리킨다.
    const panel = container.querySelector("#rail-panel-settings")!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-labelledby")).toBe("rail-settings-toggle");
    expect(gearButton().id).toBe("rail-settings-toggle");
    expect(gearButton().getAttribute("aria-controls")).toBe("rail-panel-settings");

    act(() => gearButton().click());
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
    expect(gearButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("replaces the active work panel — the exclusive card never stacks sections", () => {
    renderRail();
    act(() => gearButton().click());
    const titles = [...container.querySelectorAll(".right-rail-section-title")].map((el) => el.textContent);
    expect(titles).toEqual(["SETTINGS"]);
  });

  it("keeps the settings entry out of the panel toggle lists", () => {
    renderRail();
    // 톱니가 곧 설정의 자리다 — 같은 표면을 여는 토글이 디바이더 아래 또 서면 문이 둘이 된다.
    expect(container.querySelector("#rail-tab-settings")).toBeNull();
    act(() => gearButton().click());
    expect(container.querySelector("#rail-tab-settings")).toBeNull();
  });

  it("moves focus to the gear before a focused close button unmounts settings", () => {
    renderRail();
    act(() => gearButton().click());
    const close = sectionOf("SETTINGS").querySelector<HTMLButtonElement>(".right-rail-section-close");
    act(() => { close!.focus(); close!.click(); });
    expect(getRailStoreSnapshot().activePanelId).toBeNull();
    expect(document.activeElement).toBe(gearButton());
  });

  it("resets only the active panel's width on a divider double-click", () => {
    window.localStorage.setItem("fleet-console.rail.panelWidths", JSON.stringify({ repository: 500, codex: 452 }));
    renderRail();
    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("500px");

    // 옛 메뉴의 "패널 폭 초기화"는 조작 대상 위의 직접 조작으로 온다.
    const handle = container.querySelector<HTMLElement>(".right-rail-resize-handle");
    act(() => handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));

    expect(railRoot().style.getPropertyValue("--right-rail-panel-width")).toBe("360px");
    // 이웃의 기억은 남는다 — 초기화는 지금 선 도구의 몫이다.
    expect(JSON.parse(window.localStorage.getItem("fleet-console.rail.panelWidths")!)).toEqual({ codex: 452 });
  });

  it("leaves no portaled rail menu behind", () => {
    renderRail();
    act(() => gearButton().click());
    // 메뉴는 해체됐다 — 문서에 포털된 팝업이 더는 서지 않는다.
    expect(document.body.querySelector(".right-rail-menu")).toBeNull();
  });
});

describe("Right Rail card opacity", () => {
  it("follows the store alpha on the panel slot — the control lives in Settings > Appearance", () => {
    renderRail();
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("1");
    act(() => setRailOverlayAlpha(60));
    expect(panelSlot().style.getPropertyValue("--right-rail-overlay-alpha")).toBe("0.6");
  });
});

describe("Right Rail occupied width report", () => {
  it("reports icons + slot width while expanded and zero when the chrome collapses", () => {
    renderRail();
    expect(getRailStoreSnapshot().railOccupiedPx).toBe(44 + 360);

    act(() => setRailChromeExpanded(false));
    renderRail();
    expect(getRailStoreSnapshot().railOccupiedPx).toBe(0);
  });

  it("shrinks the report to the icon strip when nothing is active", () => {
    act(() => closeRailPanel("repository"));
    renderRail();
    expect(getRailStoreSnapshot().railOccupiedPx).toBe(44);
  });
});

describe("Right Rail icon order", () => {
  it("keeps plugin icons in composition order — actions stand in place instead of jumping ahead of panel toggles", () => {
    renderRail();
    const labels = [...container.querySelectorAll<HTMLButtonElement>(".right-rail-icons .right-rail-ico")]
      .map((button) => button.getAttribute("aria-label"));
    // 창 동사(접기)와 톱니(두 아이콘)를 뺀 나머지가 합성 순서 그대로다 — 코어 페인들 뒤에
    // 플러그인들이 등록 순서로 선다. 동작(SHELL·PLAIN)이 페인들 앞으로 끌려 나오면 이 목록이 깨진다.
    expect(labels.slice(2)).toEqual(["REPOSITORY", "CODEX", "ALERTS", "FILES", "SHELL", "PLAIN", "LEDGER"]);
  });
});

describe("Right Rail icons for surface-opening actions", () => {
  it("lights the icon while its surface holds a slot", () => {
    renderRail();
    act(() => { openExpandedSurface({ surfaceId: "shell", render: () => null }); });
    expect(iconButton("SHELL").classList.contains("is-active")).toBe(true);
    expect(iconButton("SHELL").getAttribute("aria-pressed")).toBe("true");
  });

  it("puts the icon out again when the surface closes", () => {
    renderRail();
    act(() => { openExpandedSurface({ surfaceId: "shell", render: () => null }); });
    act(() => { closeExpandedSurfacesOf("shell"); });
    expect(iconButton("SHELL").classList.contains("is-active")).toBe(false);
  });

  it("leaves an action that opens no surface unlit", () => {
    renderRail();
    act(() => iconButton("PLAIN").click());
    expect(iconButton("PLAIN").classList.contains("is-active")).toBe(false);
  });

  it("ignores a different surface standing in a slot", () => {
    renderRail();
    act(() => { openExpandedSurface({ surfaceId: "codex-reader", render: () => null }); });
    expect(iconButton("SHELL").classList.contains("is-active")).toBe(false);
  });
});

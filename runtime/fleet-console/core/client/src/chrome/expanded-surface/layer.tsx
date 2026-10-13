import { reportExpandedMinWidth, useDetailOverlayLeft } from "../rail/rail-store.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ExpandedSurfaceContext,
  ExpandedSurfaceDescriptor,
} from "@fleet-console/sdk/expanded-surface";
import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";

import { useGlobalSettingsStore } from "../../../../../features/settings/client/global-settings-store.js";
import { openOtherSurfaceLink } from "../../../../../features/browser/client/global-link.js";
import { useT } from "../../i18n/index.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { createHostCapabilities } from "../../integration/plugin-capabilities.js";
import { useHostSideBarVisible } from "../../integration/host-sidebar-visible.js";
import { useExpandedSurfaceDescriptors } from "../../integration/plugin-registry.js";
import { getState, subscribe } from "../../integration/store.js";
import { resolveConsoleLanguage } from "../../../../../features/updates/client/whatsnew-i18n.js";
import {
  closeExpandedSurface,
  focusExpandedSurface,
  focusedExpandedSurfaceIndex,
  replaceExpandedSurfaceParams,
  restoreExpandedSurfaces,
  setExpandedSurfaceWeights,
  stowExpandedSurfaces,
  useExpandedSurfaces,
  useExpandedSurfacesStowed,
  type ExpandedSurfaceInstance,
} from "./store.js";

/**
 * 두 최소폭을 실제 가용 폭에 맞춘다.
 *
 * 선언된 최소폭은 희망이지 물리가 아니다. 두 페인을 합쳐도 둘의 최소폭을 못 담는 좁은
 * 대화 칸에서 최소폭을 그대로 지키면 분할선이 통째로 얼어붙어, 사용자에게는 고장으로
 * 읽힌다. 그럴 때는 비율을 지키며 함께 물러난다.
 */
function fitMinimums(left: number, right: number, pair: number): readonly [number, number] {
  const total = left + right;
  if (total <= pair || total <= 0) return [left, right];
  const scale = pair / total;
  return [left * scale, right * scale];
}

/** 분할선이 넘어오지 못하는 페인 최소폭. 표면이 더 큰 값을 요구할 수 있다. */
const DEFAULT_MIN_PANE_WIDTH = 280;
/** 키보드로 분할선을 미는 한 걸음. */
const KEYBOARD_STEP_PX = 24;
/** 부유 조작 무리의 오른쪽 정박 여백(--space-2)과 본문 도구 사이의 숨. inset 변수에 더한다. */
const FLOAT_INSET_GUTTER_PX = 16;
/** 부유 조작 무리의 아래 끝과 그 밑에서 시작하는 본문 사이의 숨. block 변수에 더한다. */
const FLOAT_BLOCK_GUTTER_PX = 4;
/** 대화 칸 왼쪽 「대화」·「다시 열기」와 가운데 pill 사이의 최소 틈. */
const LEAD_PILL_GAP_PX = 12;

/**
 * 확대 표면 레이어 — 가운데 대화 칸에 정박하는 비모달 작업면. 사이드바·레일은 계속
 * 살아 있으므로 focus trap도 inert도 걸지 않는다. 가운데 대화 칸에 portal해
 * 칸 자체가 잠시 표면이 된다 — 사이드바·오른쪽 열은 칸 경계 밖이라 가려지지 않는다. 칸 머리 줄은
 * 대화 pill 줄과 같은 문법(가운데 이름 pill)이고, 「대화」로 접어 두면 페인은 산 채로 숨고
 * 같은 자리에 「다시 열기」 칩이 남는다.
 */
export function ExpandedSurfaceLayer() {
  const descriptors = useExpandedSurfaceDescriptors();
  const { instances, focusedInstanceId } = useExpandedSurfaces();
  const stowed = useExpandedSurfacesStowed();
  const t = useT();
  const theaterId = useSyncExternalStore(subscribe, () => getState().activeTheaterId, () => null);
  const theme = useSyncExternalStore(subscribe, () => getState().activeTheme, () => "instrument" as const);
  const globalSettings = useGlobalSettingsStore();
  const language = resolveConsoleLanguage(globalSettings.state?.language ?? "auto");
  const capabilities = useHostCapabilities();


  const gridRef = useRef<HTMLDivElement>(null);
  const [paneWidths, setPaneWidths] = useState<readonly number[]>([]);
  const [measuredMinimums, setMeasuredMinimums] = useState<Readonly<Record<string, number>>>({});
  const reportMinimum = useCallback((id: string, px: number | null) => {
    const value = px !== null && Number.isFinite(px) && px > 0 ? Math.ceil(px) : undefined;
    setMeasuredMinimums((current) => {
      if (current[id] === value) return current;
      const next = { ...current };
      if (value === undefined) delete next[id]; else next[id] = value;
      return next;
    });
  }, []);
  useEffect(() => {
    const ids = new Set(instances.map((instance) => instance.instanceId));
    setMeasuredMinimums((current) => Object.keys(current).some((id) => !ids.has(id))
      ? Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))) : current);
    setPaneTitles((current) => Object.keys(current).some((id) => !ids.has(id))
      ? Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))) : current);
  }, [instances]);

  const open = instances.length > 0;

  // 확대 표면이 서 있다는 유일한 교차 모듈 신호. CSS(대화 칸 표면 표시)와
  // 전역 단축키 양보가 이 한 속성을 읽는다. 대화 칸에 접어 둔 동안은 대화가 칸의 주인이다.
  useEffect(() => {
    if (!open || stowed) return;
    document.body.setAttribute("data-expanded-surface", "true");
    return () => {
      document.body.removeAttribute("data-expanded-surface");
    };
  }, [open, stowed]);

  // 대화 칸은 이 레이어보다 먼저 그려지는 형제다 — 렌더 중에 찾으면 첫 렌더(새로고침 뒤 복원)에는 아직 없어
  // body로 떨어진다. 커밋 뒤에 찾아 두고, 찾기 전에는 아무것도 세우지 않는다.
  const [stageHost, setStageHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const found = document.querySelector<HTMLElement>(".conversation-stage");
    setStageHost((current) => (current === found ? current : found));
  }, [open]);

  // 페인 제목 — 머리 pill·칩이 초점 페인의 이름을 말한다. 제목은 페인이 컨텍스트로 풀어 올려 준다.
  const [paneTitles, setPaneTitles] = useState<Readonly<Record<string, string>>>({});
  const reportTitle = useCallback((id: string, title: string) => {
    setPaneTitles((current) => (current[id] === title ? current : { ...current, [id]: title }));
  }, []);

  // 칸 왼쪽의 「대화」·「다시 열기」가 차지한 폭을 칸에 알린다 — 대화 pill 줄과 표면 머리 줄이 그만큼 양쪽을 비워
  // 가운데 pill 과 겹치지 않는다(사용량 캡슐 예약과 큰 쪽을 쓴다, conversation.css).
  const leadRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const stage = stageHost;
    const lead = leadRef.current;
    if (!stage || !lead || !open) return;
    const publish = () => {
      const space = Math.ceil(lead.getBoundingClientRect().right - stage.getBoundingClientRect().left) + LEAD_PILL_GAP_PX;
      stage.style.setProperty("--conversation-lead-space", `${Math.max(0, space)}px`);
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(lead);
    observer?.observe(stage);
    return () => {
      observer?.disconnect();
      stage.style.removeProperty("--conversation-lead-space");
    };
  }, [open, stageHost, stowed]);

  // 실제로 놓인 페인 폭을 표면에 통보한다 — 표면은 이 값으로 스스로 열화한다.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const widths = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-pane"))
        .map((pane) => pane.getBoundingClientRect().width);
      setPaneWidths((previous) =>
        previous.length === widths.length && previous.every((value, index) => Math.abs(value - (widths[index] ?? 0)) < 0.5)
          ? previous
          : widths,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    for (const pane of grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-pane")) {
      observer.observe(pane);
    }
    return () => observer.disconnect();
    // 대화 칸의 그리드는 칸을 찾은 뒤에 선다 — 그때 다시 잰다.
  }, [instances.length, stageHost]);

  const minWidthFor = useCallback(
    (instance: ExpandedSurfaceInstance): number => {
      const descriptor = descriptors.get(instance.surfaceId);
      // 이름이 바뀐 뒤에도 옛 이름으로 등록된 기여가 자기 하한을 잃지 않아야 한다.
      const declared = measuredMinimums[instance.instanceId] ?? descriptor?.minPaneWidth ?? descriptor?.minSlotWidth;
      return typeof declared === "number" && Number.isFinite(declared) && declared > 0
        ? declared
        : DEFAULT_MIN_PANE_WIDTH;
    },
    [descriptors, measuredMinimums],
  );

  const reservedWidth = instances.reduce((sum, instance) => sum + minWidthFor(instance), 0) + Math.max(0, instances.length - 1) * 8;
  useLayoutEffect(() => { reportExpandedMinWidth(reservedWidth); }, [reservedWidth]);
  useLayoutEffect(() => () => reportExpandedMinWidth(0), []);

  /**
   * 분할선 드래그. 인접한 두 페인 사이에서만 폭을 주고받는다 — 하나를 넓히면 그
   * 오른쪽 이웃만 줄어들고, 나머지 페인은 사용자가 맞춰 둔 폭을 그대로 지킨다.
   */
  const beginDivergeDrag = useCallback(
    (dividerIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
      const grid = gridRef.current;
      if (!grid) return;
      event.preventDefault();
      const panes = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-pane"));
      const startWidths = panes.map((pane) => pane.getBoundingClientRect().width);
      const startX = event.clientX;
      const leftMin = minWidthFor(instances[dividerIndex]!);
      const rightMin = minWidthFor(instances[dividerIndex + 1]!);
      const leftStart = startWidths[dividerIndex] ?? 0;
      const rightStart = startWidths[dividerIndex + 1] ?? 0;
      const pair = leftStart + rightStart;
      const [leftFloor, rightFloor] = fitMinimums(leftMin, rightMin, pair);

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      target.classList.add("is-dragging");
      document.body.setAttribute("data-expanded-surface-resizing", "true");

      const applyDelta = (delta: number) => {
        const left = Math.max(leftFloor, Math.min(pair - rightFloor, leftStart + delta));
        const next = [...startWidths];
        next[dividerIndex] = left;
        next[dividerIndex + 1] = pair - left;
        setExpandedSurfaceWeights(next);
      };

      const onMove = (moveEvent: PointerEvent) => applyDelta(moveEvent.clientX - startX);
      const onUp = () => {
        target.releasePointerCapture(event.pointerId);
        target.classList.remove("is-dragging");
        document.body.removeAttribute("data-expanded-surface-resizing");
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [instances, minWidthFor],
  );

  const nudgeDivider = useCallback(
    (dividerIndex: number, deltaPx: number) => {
      const grid = gridRef.current;
      if (!grid) return;
      const panes = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .expanded-surface-pane"));
      const widths = panes.map((pane) => pane.getBoundingClientRect().width);
      const leftMin = minWidthFor(instances[dividerIndex]!);
      const rightMin = minWidthFor(instances[dividerIndex + 1]!);
      const leftStart = widths[dividerIndex] ?? 0;
      const rightStart = widths[dividerIndex + 1] ?? 0;
      const pair = leftStart + rightStart;
      const [leftFloor, rightFloor] = fitMinimums(leftMin, rightMin, pair);
      const left = Math.max(leftFloor, Math.min(pair - rightFloor, leftStart + deltaPx));
      const next = [...widths];
      next[dividerIndex] = left;
      next[dividerIndex + 1] = pair - left;
      setExpandedSurfaceWeights(next);
    },
    [instances, minWidthFor],
  );

  // Esc는 포커스된 페인 하나만 닫는다. 표면 내부의 보조 표면(찾기·오버레이)이 먼저
  // 먹을 기회를 갖도록 버블 단계에서 듣는다 — 페인이 stopPropagation으로 가져간다.
  // 키가 작업면 **안에서** 눌렸을 때만 닫는다(S-07). 사이드바 메뉴·다른 입력창·빈 본문에서 누른 Esc는
  // 그 자리의 것을 닫으려는 뜻이다 — 예전처럼 "포커스된 페인이 없으면 마지막 페인"으로 떨어지면 메뉴와
  // Shell이 함께 닫힌다. 작업면 안이어도 메뉴·대화상자 안의 Esc는 그 메뉴의 몫이다.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        const origin = event.target instanceof Element ? event.target : null;
        if (!origin?.closest(".expanded-surface")) return;
        if (origin.closest('[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"]')) return;
        const index = focusedExpandedSurfaceIndex();
        const target = index === -1 ? undefined : instances[index];
        if (!target) return;
        event.preventDefault();
        // 대화 칸에서는 Esc가 칸을 대화에 돌려준다 — 페인은 접어 둘 뿐 닫지 않는다(「대화」 단추와 같은 길).
        // 접힌 페인은 inert 라 그 안의 포커스가 갈 곳을 잃는다 — 같은 자리의 「다시 열기」로 옮긴다.
        stowExpandedSurfaces();
        queueMicrotask(() => leadRef.current?.focus({ preventScroll: true }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [instances, open]);

  if (!open) return null;

  // 분할선도 그리드 자식이다 — 페인 트랙만 세면 자식 수가 트랙 수를 넘어 다음 줄로
  // 접히고, 나란히 놓으려던 페인이 위아래로 쌓인다. 트랙을 페인·분할선 순으로 짠다.
  const template = instances
    .map((instance) => `${Math.max(0.0001, instance.weight)}fr`)
    .join(" var(--space-2) ");

  const panes = instances.map((instance, index) => {
    const descriptor = descriptors.get(instance.surfaceId);
    const focused = instance.instanceId === focusedInstanceId;
    return (
      <SurfacePane
        key={instance.instanceId}
        instance={instance}
        descriptor={descriptor}
        index={index}
        paneCount={instances.length}
        paneWidth={paneWidths[index] ?? 0}
        focused={focused}
        theaterId={theaterId}
        theme={theme}
        language={language}
        capabilities={capabilities}
        isLast={index === instances.length - 1}
        onReportMinimum={reportMinimum}
        onReportTitle={reportTitle}
        onDividerPointerDown={beginDivergeDrag}
        onDividerNudge={nudgeDivider}
      />
    );
  });

  // 칸을 찾기 전에는 세우지 않는다 — body로 떨어지면 창 전체를 덮는다.
  if (!stageHost) return null;
  const lead = instances.find((instance) => instance.instanceId === focusedInstanceId) ?? instances[0]!;
  const title = paneTitles[lead.instanceId] || t("chrome.expandedSurface.regionAria");
  const more = instances.length - 1;
  return createPortal(
    <>
      <div
        className={`expanded-surface is-conversation${stowed ? " is-stowed" : ""}`}
        data-pane-count={instances.length}
        role="region"
        aria-label={t("chrome.expandedSurface.regionAria")}
        inert={stowed}
      >
        <div className="conversation-pill-row expanded-surface-head">
          <span className="conversation-pill expanded-surface-head-pill">
            <span className="conversation-pill-title">{title}</span>
            {more > 0 ? <span className="conversation-pill-sub">· {t("chrome.expandedSurface.morePanes", { count: more })}</span> : null}
          </span>
        </div>
        <div ref={gridRef} className="expanded-surface-grid" style={{ gridTemplateColumns: template }}>
          {panes}
        </div>
      </div>
      <button
        ref={leadRef}
        type="button"
        className={`expanded-surface-lead${stowed ? " is-reopen" : ""}`}
        aria-label={stowed ? t("chrome.expandedSurface.reopenAria", { title }) : t("chrome.expandedSurface.backAria")}
        title={stowed ? t("chrome.expandedSurface.reopenAria", { title }) : t("chrome.expandedSurface.backAria")}
        onClick={stowed ? restoreExpandedSurfaces : stowExpandedSurfaces}
      >
        {stowed ? (
          <>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 6.5V3h3.5M13 9.5V13H9.5M3 3l4 4M13 13l-4-4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="expanded-surface-lead-label">{title}</span>
          </>
        ) : (
          <>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M9.5 3.5 5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="expanded-surface-lead-label">{t("chrome.expandedSurface.back")}</span>
          </>
        )}
      </button>
    </>,
    stageHost,
  );
}

export function SurfacePane({
  instance,
  descriptor,
  index,
  paneCount,
  paneWidth,
  focused,
  theaterId,
  theme,
  language,
  capabilities,
  isLast,
  onReportMinimum,
  onReportTitle,
  onDividerPointerDown,
  onDividerNudge,
}: {
  readonly instance: ExpandedSurfaceInstance;
  readonly descriptor: ExpandedSurfaceDescriptor | undefined;
  readonly index: number;
  readonly onReportMinimum: (id: string, px: number | null) => void;
  /** 대화 칸 머리 pill 이 읽는 제목 통보 — 모바일 화면처럼 머리를 따로 그리는 자리는 생략한다. */
  readonly onReportTitle?: (id: string, title: string) => void;
  readonly paneCount: number;
  readonly paneWidth: number;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly theme: ReturnType<typeof getState>["activeTheme"];
  readonly language: ReturnType<typeof resolveConsoleLanguage>;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly isLast: boolean;
  readonly onDividerPointerDown: (dividerIndex: number, event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onDividerNudge: (dividerIndex: number, deltaPx: number) => void;
}) {
  const t = useT();

  // 부유 조작이 본문 위에 떠 있으므로, 본문 첫 줄의 오른쪽 끝 도구가 그 밑에 깔릴 수 있다.
  // 조작 무리의 실제 폭(tools 유무에 따라 다르다)을 CSS 변수로 페인에 싣고, 첫 줄을 갖는
  // 표면은 그 변수만큼 오른쪽 여백을 둔다 — 레일 마운트에는 변수가 없어 fallback 0이 된다.
  // 첫 줄만 비울 수 없는 격자 본문(터미널)은 대신 조작 무리의 아래 끝(block 변수) 밑에서 시작한다.
  const paneRef = useRef<HTMLElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const overlayLeft = useDetailOverlayLeft();
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const publish = () => {
      const rect = pane.getBoundingClientRect();
      const covered = overlayLeft === null ? 0 : Math.max(0, Math.min(rect.width, rect.right - overlayLeft));
      pane.style.setProperty("--expanded-surface-overlay-inset", `${Math.ceil(covered)}px`);
      pane.style.setProperty("--expanded-surface-visible-width", `${Math.max(0, Math.floor(rect.width - covered))}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [overlayLeft, paneWidth]);
  useEffect(() => {
    const pane = paneRef.current;
    const float = floatRef.current;
    if (!pane || !float || typeof ResizeObserver === "undefined") return;
    const publish = () => {
      const rect = float.getBoundingClientRect();
      pane.style.setProperty("--expanded-surface-float-width", `${Math.ceil(rect.width) + FLOAT_INSET_GUTTER_PX}px`);
      pane.style.setProperty("--expanded-surface-float-block", `${Math.ceil(float.offsetTop + rect.height) + FLOAT_BLOCK_GUTTER_PX}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(float);
    return () => observer.disconnect();
  }, []);

  const sideBarVisible = useHostSideBarVisible();
  const reportMinPaneWidth = useCallback((px: number | null) => onReportMinimum(instance.instanceId, px), [instance.instanceId, onReportMinimum]);
  const context = useMemo<ExpandedSurfaceContext>(() => ({
    surfaceId: instance.surfaceId,
    instanceId: instance.instanceId,
    params: instance.params,
    paneIndex: index,
    paneCount,
    paneWidth,
    reportMinPaneWidth,
    // 옛 이름도 같은 값으로 함께 싣는다 — 이름이 바뀌었다고 이미 배포된 본문이 폭을
    // 잃으면 개명이 곧 고장이 된다.
    slotIndex: index,
    slotCount: paneCount,
    slotWidth: paneWidth,
    focused,
    theaterId,
    navigate: capabilities.navigate,
    shell: capabilities.shell,
    rail: capabilities.rail,
    consoleState: capabilities.consoleState,
    notifications: capabilities.notifications,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    preferences: capabilities.preferences,
    language,
    theme,
    sideBarVisible,
    // 확대 표면의 http(s) 링크를 여는 길 — bubble 라우터가 닿지 않는 자리에서 명시 호출한다.
    openLink: (url, options) => openOtherSurfaceLink(url, options?.gesture ?? "click"),
    close: () => closeExpandedSurface(instance.instanceId),
    focus: () => focusExpandedSurface(instance.instanceId),
    replaceParams: (next) => replaceExpandedSurfaceParams(instance.instanceId, next),
  }), [reportMinPaneWidth, capabilities, focused, index, instance, language, paneCount, paneWidth, sideBarVisible, theaterId, theme]);

  // 제목은 aria-label이라 문자열이어야 하고, 그래서 자식 컴포넌트로 미룰 수 없다 —
  // 경계가 잡아 줄 수 없는 유일한 콜백이므로 여기서 직접 막는다.
  const title = safeTitle(descriptor, context, language, instance.surfaceId);
  // 대화 칸의 머리 pill·칩이 이 이름을 말한다.
  useEffect(() => { onReportTitle?.(instance.instanceId, title); }, [instance.instanceId, onReportTitle, title]);

  return (
    <>
      <section
        ref={paneRef}
        className={`expanded-surface-pane${focused ? " is-focused" : ""}`}
        aria-label={title}
        onPointerDownCapture={() => focusExpandedSurface(instance.instanceId)}
        onFocusCapture={() => focusExpandedSurface(instance.instanceId)}
      >
        {/* 머리 줄은 없다 — 본문이 페인 위 가장자리까지 채우고, 이름은 aria-label로만 남는다.
            창 조작(닫기)과 표면이 내는 tools는 본문 위 오른쪽 모서리에 부유한다.
            닫는 길을 스스로 가진 표면(ownsClose)에는 닫기를 띄우지 않는다. */}
        <div ref={floatRef} className="expanded-surface-pane-float">
          {descriptor?.tools ? (
            <div className="expanded-surface-pane-tools">
              <PluginErrorBoundary><SurfacePanePart render={descriptor.tools} context={context} /></PluginErrorBoundary>
            </div>
          ) : null}
          {descriptor?.ownsClose ? null : <button
            className="expanded-surface-pane-close"
            type="button"
            aria-label={t("chrome.expandedSurface.closeAria", { title })}
            title={t("chrome.expandedSurface.closeAria", { title })}
            onClick={() => closeExpandedSurface(instance.instanceId)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            </svg>
          </button>}
        </div>
        <div className="expanded-surface-pane-body">
          {descriptor?.aside ? (
            <aside className="expanded-surface-pane-aside">
              <PluginErrorBoundary><SurfacePanePart render={descriptor.aside} context={context} /></PluginErrorBoundary>
            </aside>
          ) : null}
          <div className="expanded-surface-pane-main">
            <PluginErrorBoundary>
              {descriptor
                ? <SurfacePanePart render={descriptor.render} context={context} />
                : <MissingSurface surfaceId={instance.surfaceId} />}
            </PluginErrorBoundary>
          </div>
        </div>
      </section>
      {isLast ? null : (
        <div
          className="expanded-surface-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("chrome.expandedSurface.dividerAria")}
          tabIndex={0}
          onPointerDown={(event) => onDividerPointerDown(index, event)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              onDividerNudge(index, -KEYBOARD_STEP_PX);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              onDividerNudge(index, KEYBOARD_STEP_PX);
            }
          }}
        >
          <span className="expanded-surface-divider-grip" aria-hidden="true" />
        </div>
      )}
    </>
  );
}

/**
 * 표면을 기여하던 플러그인이 사라졌는데 페인은 남은 경우. 조용히 빈 칸을 두면
 * 사용자는 콘솔이 깨진 줄 안다 — 무엇이 없어졌는지 말하고 닫을 길을 준다.
 */
function MissingSurface({ surfaceId }: { readonly surfaceId: string }) {
  const t = useT();
  return (
    <div className="expanded-surface-missing">
      <p>{t("chrome.expandedSurface.missing")}</p>
      <code>{surfaceId}</code>
    </div>
  );
}

/**
 * 플러그인 콜백은 경계 **아래에서** 불려야 한다.
 *
 * `<PluginErrorBoundary>{descriptor.render(ctx)}</PluginErrorBoundary>`는 그렇지 않다 —
 * 자식은 부모의 렌더 중에 평가되므로, 던지는 순간 경계는 아직 트리에 없고 예외는 그대로
 * 위로 올라가 Operations 화면을 통째로 무너뜨린다. 한 칸 아래 컴포넌트로 미뤄야 잡힌다.
 */
function SurfacePanePart({
  render,
  context,
}: {
  readonly render: (ctx: ExpandedSurfaceContext) => ReactNode;
  readonly context: ExpandedSurfaceContext;
}) {
  return <>{render(context)}</>;
}

function safeTitle(
  descriptor: ExpandedSurfaceDescriptor | undefined,
  context: ExpandedSurfaceContext,
  language: ConsoleLocale,
  fallback: string,
): string {
  if (!descriptor) return fallback;
  try {
    return resolveLocalizedText(descriptor.title(context), language);
  } catch {
    // 이름을 못 대는 표면이라도 페인은 서 있어야 한다 — 사용자는 닫기라도 누를 수 있어야 한다.
    return fallback;
  }
}

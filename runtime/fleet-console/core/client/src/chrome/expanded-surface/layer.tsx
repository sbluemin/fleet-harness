import { useDetailOverlayLeft } from "../rail/rail-store.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "../../../../../features/workspace/shared/expanded-surface.js";
import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import type { ConsoleLocale } from "@fleet-console/i18n";
import type { ConversationToolScope } from "../../../../../features/workspace/shared/pane.js";
import { resolveLocalizedText } from "@fleet-console/i18n/translate";

import { openOtherSurfaceLink } from "../../../../../features/browser/client/global-link.js";
import { useT } from "../../i18n/index.js";
import { createHostCapabilities } from "../../integration/feature-capabilities.js";
import { useHostSideBarVisible } from "../../integration/host-sidebar-visible.js";
import { getState } from "../../integration/store.js";
import { resolveConsoleLanguage } from "../../../../../features/updates/client/whatsnew-i18n.js";
import {
  closeExpandedSurface,
  focusExpandedSurface,
  replaceExpandedSurfaceParams,
  type ExpandedSurfaceInstance,
} from "./store.js";

/** 키보드로 분할선을 미는 한 걸음. */
const KEYBOARD_STEP_PX = 24;
/** 부유 조작 무리의 오른쪽 정박 여백(--space-2)과 본문 도구 사이의 숨. inset 변수에 더한다. */
const FLOAT_INSET_GUTTER_PX = 16;
/** 부유 조작 무리의 아래 끝과 그 밑에서 시작하는 본문 사이의 숨. block 변수에 더한다. */
const FLOAT_BLOCK_GUTTER_PX = 4;

/*
 * 데스크톱의 가운데 덮개(ExpandedSurfaceLayer)는 퇴역했다 — 데스크톱 대화 화면에서 표면은 대화별 도구 작업대의 칸으로 선다
 * (features/workspace/client/conversation/workbench). 이 모듈에는 폰 배치(도구 시트·목적지 화면)가 쓰는 페인 껍데기와,
 * 두 자리가 함께 쓰는 표면 문맥 구성만 남는다.
 */

/** 표면 본문이 받는 컨텍스트 — 폰 페인과 데스크톱 도구 칸이 같은 길로 만든다. 닫기·포커스·주소 갈아타기는 자리마다 다르다. */
export function useExpandedSurfaceContext({
  instance,
  index,
  paneCount,
  paneWidth,
  focused,
  theaterId,
  theme,
  language,
  capabilities,
  onReportMinimum,
  close,
  focus,
  replaceParams,
  conversation,
}: {
  readonly instance: ExpandedSurfaceInstance;
  readonly index: number;
  readonly paneCount: number;
  readonly paneWidth: number;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly theme: ReturnType<typeof getState>["activeTheme"];
  readonly language: ConsoleLocale;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly onReportMinimum: (id: string, px: number | null) => void;
  readonly close: () => void;
  readonly focus: () => void;
  readonly replaceParams: (next: Readonly<Record<string, string>>) => void;
  /** 표면이 놓인 대화 — 데스크톱 대화의 도구 칸에서만 싣는다. */
  readonly conversation?: ConversationToolScope | undefined;
}): ExpandedSurfaceContext {
  const sideBarVisible = useHostSideBarVisible();
  const reportMinPaneWidth = useCallback((px: number | null) => onReportMinimum(instance.instanceId, px), [instance.instanceId, onReportMinimum]);
  // 닫기·포커스·주소 갈아타기는 자리(폰 목록·도구 칸)마다 다르다 — 최신 손잡이를 ref 로 읽어 컨텍스트가 렌더마다 새로 서지 않게 한다.
  const closeRef = useRef(close);
  closeRef.current = close;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const replaceRef = useRef(replaceParams);
  replaceRef.current = replaceParams;
  return useMemo<ExpandedSurfaceContext>(() => ({
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
    ...(conversation === undefined ? {} : { conversation }),
    // 확대 표면의 http(s) 링크를 여는 길 — bubble 라우터가 닿지 않는 자리에서 명시 호출한다.
    openLink: (url, options) => openOtherSurfaceLink(url, options?.gesture ?? "click"),
    close: () => closeRef.current(),
    focus: () => focusRef.current(),
    replaceParams: (next) => replaceRef.current(next),
  }), [reportMinPaneWidth, capabilities, conversation, focused, index, instance.instanceId, instance.params, instance.surfaceId, language, paneCount, paneWidth, sideBarVisible, theaterId, theme]);
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

  const context = useExpandedSurfaceContext({
    instance,
    index,
    paneCount,
    paneWidth,
    focused,
    theaterId,
    theme,
    language,
    capabilities,
    onReportMinimum,
    close: () => closeExpandedSurface(instance.instanceId),
    focus: () => focusExpandedSurface(instance.instanceId),
    replaceParams: (next) => replaceExpandedSurfaceParams(instance.instanceId, next),
  });

  // 제목은 aria-label이라 문자열이어야 하고, 그래서 자식 컴포넌트로 미룰 수 없다 —
  // 경계가 잡아 줄 수 없는 유일한 콜백이므로 여기서 직접 막는다.
  const title = safeExpandedSurfaceTitle(descriptor, context, language, instance.surfaceId);
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
              <FeatureErrorBoundary><SurfacePanePart render={descriptor.tools} context={context} /></FeatureErrorBoundary>
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
              <FeatureErrorBoundary><SurfacePanePart render={descriptor.aside} context={context} /></FeatureErrorBoundary>
            </aside>
          ) : null}
          <div className="expanded-surface-pane-main">
            <FeatureErrorBoundary>
              {descriptor
                ? <SurfacePanePart render={descriptor.render} context={context} />
                : <MissingSurface surfaceId={instance.surfaceId} />}
            </FeatureErrorBoundary>
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
export function MissingSurface({ surfaceId }: { readonly surfaceId: string }) {
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
 * `<FeatureErrorBoundary>{descriptor.render(ctx)}</FeatureErrorBoundary>`는 그렇지 않다 —
 * 자식은 부모의 렌더 중에 평가되므로, 던지는 순간 경계는 아직 트리에 없고 예외는 그대로
 * 위로 올라가 Operations 화면을 통째로 무너뜨린다. 한 칸 아래 컴포넌트로 미뤄야 잡힌다.
 */
export function SurfacePanePart({
  render,
  context,
}: {
  readonly render: (ctx: ExpandedSurfaceContext) => ReactNode;
  readonly context: ExpandedSurfaceContext;
}) {
  return <>{render(context)}</>;
}

export function safeExpandedSurfaceTitle(
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

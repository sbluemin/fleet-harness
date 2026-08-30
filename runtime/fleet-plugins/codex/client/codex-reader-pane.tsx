import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { CaptionActionButton } from "@fleet-console/sdk/components/caption-actions";
import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";

import {
  getCodexReaderDocumentState,
  getCodexReaderHistoryState,
  mountReaderInto,
  navigateCodexReaderHistory,
  refreshCodexHealth,
  saveReaderScroll,
  setNavigatorTagFilter,
  subscribeCodexReaderDocument,
  subscribeCodexReaderHistory,
} from "./codex-host.js";
import { getT } from "./i18n/index.js";
import { resolvedCodexWorkspaceIdFor, subscribeCodexWorkspace } from "./workspace-store.js";
import { closeCodexReader, expandCodexReader, openCodexReader, useConsoleLocale, useReaderState } from "./reader-store.js";
import { loadInitialData } from "./codex/state.js";

/**
 * 문서 창 — 표면의 detail 열.
 *
 * 네비게이터와 한 본문 안에 있던 시절 이 절반은 `codex-rail-host.is-split` 격자의 첫 칸이었고,
 * 폭(`requestExtraWidth`)과 닫기 버튼을 스스로 그렸다. 이제 그 둘은 표면이 진다.
 *
 * 본문은 여전히 명령형 DOM이다 — 리더·목차·도크는 React가 아니라 `mountReaderInto`가 그린다.
 * 열이 갈라져도 그 사실은 바뀌지 않는다: 마운트 지점 셋이 이 서브트리 안에 함께 있으면 된다.
 */

export const CODEX_READER_PANE_ID = "codex-reader";

const OUTLINE_COLLAPSED_KEY = "fleet.codex.outline.collapsed";

export const codexReaderPane: PaneDescriptor = {
  id: CODEX_READER_PANE_ID,
  role: "detail",
  // 확대는 Codex 자신의 표면이 진다(`codexReadingSurface`) — 읽기 시트는 목차·도크·정독 도구를
  // 함께 세우는 별도 화면이라, 같은 본문을 캔버스에 옮기는 호스트 내장 확대와 다르다.
  // 그래서 `"expanded"`를 선언하지 않고 확대 버튼을 캡션 동작으로 직접 세운다.
  mounts: ["rail"],
  title: (ctx) => documentTitle(ctx),
  render: (ctx) => <CodexReaderPane {...ctx} />,
  captionActions: (ctx) => <CodexReaderCaptionActions {...ctx} />,
  // 이 열이 곧 "무엇을 읽고 있는가"다. 열만 치우고 그 사실을 남겨 두면, 다음 상태 발행에서
  // 카탈로그가 사용자가 닫은 열을 되살린다.
  onClose: () => closeCodexReader(),
  defaultWidth: 360,
  minWidth: 260,
};

/**
 * 캡션 이름은 `params`에서 읽는다.
 *
 * 문서 제목은 명령형 리더가 비동기로 알려 주는 사실이라 React 밖에 산다. 서술자의 `title`이
 * 그 모듈을 직접 읽으면 값은 맞지만 **캡션이 다시 그려질 이유가 없어** 옛 이름이 남는다.
 * 그래서 리더가 제목을 알게 될 때 주소에 실어 두고, 캡션은 그 주소를 읽는다.
 */
/**
 * 문서 열이 지금 서 있어야 하는가.
 *
 * 읽을 것이 있고 확대가 아닐 때만 선다. 확대 중에는 읽기 시트가 같은 문서를 캔버스에서
 * 그리므로 레일의 열은 물러난다 — 둘이 함께 서면 같은 문서가 두 자리에서 각자 스크롤을
 * 기억한다. 규칙을 값으로 떼어 두는 이유는 이것이 카탈로그 열의 effect가 매번 다시 판단해야
 * 하는 사실이면서, 화면 없이도 검증할 수 있어야 하는 계약이기 때문이다.
 */
export function shouldStandReaderColumn(state: {
  readonly codexReader: unknown;
  readonly codexReaderExpanded: boolean;
}): boolean {
  return state.codexReader !== null && !state.codexReaderExpanded;
}

function documentTitle(ctx: PaneContext): string {
  const t = getT(ctx.language ?? "en");
  return ctx.params.title || t("chrome.codexReading.eyebrow");
}

function CodexReaderPane(ctx: PaneContext) {
  const t = getT(ctx.language);
  const locale = useConsoleLocale();
  const state = useReaderState();
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(readOutlineCollapsed);
  const [activeSection, setActiveSection] = useState("");

  const theaterId = ctx.theaterId;
  const workspaceId = useSyncExternalStore(
    subscribeCodexWorkspace,
    () => resolvedCodexWorkspaceIdFor(theaterId),
    () => resolvedCodexWorkspaceIdFor(theaterId),
  );

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const expanded = state.codexReaderExpanded;
  const readerKey = reader
    ? `${reader.kind}:${reader.kind === "entry" ? reader.entryId : reader.kind === "drydock" ? (reader.patchId ?? "") : reader.kind === "conflicts" ? (reader.id ?? "") : (reader.templateId ?? "")}`
    : null;

  // 패널 DOM이 detach되기 전에 현재 reader 위치를 싱글톤에 저장한다.
  useLayoutEffect(() => () => saveReaderScroll(), []);

  // split reader mount — expanded=true면 읽기 시트가 처리 중이므로 건너뜀
  useEffect(() => {
    if (!workspaceId || !hasReader || expanded) return;
    if (!readRef.current || !tocRef.current || !dockRef.current || !reader) return;
    const kind = reader.kind;
    const subId = kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : kind === "schema" ? reader.templateId : undefined;
    mountReaderInto(readRef.current, tocRef.current, dockRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId: workspaceId,
      sessionTheaterId: theaterId,
      onRelatedClick: (id) => openCodexReader({ kind: "entry", entryId: id }),
      onClose: () => closeCodexReader(),
      onPatchOpen: (pid) => openCodexReader({ kind: "drydock", patchId: pid }),
      onConflictOpen: (id) => openCodexReader({ kind: "conflicts", id }),
      onTagClick: (tag) => setNavigatorTagFilter(tag),
      onDecided: () => {
        void loadInitialData();
        refreshCodexHealth();
        openCodexReader({ kind: "drydock", patchId: undefined });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, hasReader, expanded, readerKey, locale, theaterId]);

  // 접힌 아웃라인 스파인이 현재 섹션명을 되비추도록 스크롤 스파이의 활성 전환을 구독한다.
  useEffect(() => {
    const outline = outlineRef.current;
    if (!outline) return;
    const onActive = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      setActiveSection(detail?.text ?? "");
    };
    outline.addEventListener("codex-toc-active", onActive);
    // 확대 시트가 도는 동안의 활성 전환 이벤트는 이 리스너 밖에서 지나간다 — 재부착 시점에
    // 재배치된 TOC의 활성 표식에서 상태를 다시 읽어 낡은 섹션명이 남지 않게 한다.
    // (리더 마운트 effect가 먼저 선언되어 TOC 재배치가 이 시점엔 끝나 있다.)
    const active = outline.querySelector<HTMLElement>('.codex-doc-toc-inline [aria-current="location"]');
    setActiveSection(active?.textContent ?? "");
    return () => outline.removeEventListener("codex-toc-active", onActive);
    // 아웃라인이 (재)마운트되는 모든 전이에서 다시 걸려야 한다 — 리더 마운트 effect와 같은 의존성.
  }, [workspaceId, hasReader, expanded, readerKey]);

  // 제목은 명령형 리더에게서 온다 — 알게 될 때 주소에 실어야 캡션이 따라 그려진다.
  const documentState = useSyncExternalStore(
    subscribeCodexReaderDocument,
    getCodexReaderDocumentState,
    getCodexReaderDocumentState,
  );
  const panes = ctx.panes;
  const addressTitle = ctx.params.title;
  useEffect(() => {
    const next = documentState.title;
    if (!next || next === addressTitle) return;
    panes.replaceParams({ title: next });
  }, [addressTitle, documentState.title, panes]);

  return (
    <div className="codex-doc-pane">
      <section
        ref={outlineRef}
        className="codex-doc-outline"
        data-codex-outline
        data-collapsed={outlineCollapsed}
        data-toc-count="0"
      >
        <button
          className="codex-doc-outline-toggle"
          type="button"
          aria-expanded={!outlineCollapsed}
          onClick={() => {
            const next = !outlineCollapsed;
            setOutlineCollapsed(next);
            writeOutlineCollapsed(next);
          }}
        >
          <span className="codex-doc-outline-label">
            <span>{t("codex.nav.outline")} · <span data-codex-outline-count>0</span></span>
            {outlineCollapsed && activeSection ? (
              <span className="codex-doc-outline-current" title={activeSection}>{activeSection}</span>
            ) : null}
          </span>
          <span className="codex-doc-outline-chevron" aria-hidden="true">⌄</span>
        </button>
        <div ref={tocRef} className="codex-doc-toc-inline" />
      </section>
      <div ref={readRef} className="codex-doc-scroll" />
      <div ref={dockRef} className="codex-reader-composer" />
    </div>
  );
}

/**
 * 캡션 동작 선반 — 이력과 확대.
 *
 * 예전에는 `codex-doc-pane-head`가 이 셋(뒤로·앞으로·확대)과 닫기를 함께 그렸다. 닫기는
 * 호스트 몫이 되었고, 나머지는 호스트 밴드의 문법으로 옮겼다.
 */
function CodexReaderCaptionActions(ctx: PaneContext) {
  const t = getT(ctx.language);
  const history = useSyncExternalStore(
    subscribeCodexReaderHistory,
    getCodexReaderHistoryState,
    getCodexReaderHistoryState,
  );

  return (
    <>
      <CaptionActionButton
        label={t("codex.nav.backAria")}
        actionId="codex-back"
        disabled={!history.canGoBack}
        onClick={() => navigateCodexReaderHistory(-1)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CaptionActionButton>
      <CaptionActionButton
        label={t("codex.nav.forwardAria")}
        actionId="codex-forward"
        disabled={!history.canGoForward}
        onClick={() => navigateCodexReaderHistory(1)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CaptionActionButton>
      <CaptionActionButton
        label={t("rail.codex.expandAria")}
        actionId="codex-expand"
        onClick={() => expandCodexReader()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-codex-expand="true">
          <path d="M9.5 3.5h3v3M6.5 12.5h-3v-3M12.5 3.5 9 7M3.5 12.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CaptionActionButton>
    </>
  );
}

function readOutlineCollapsed(): boolean {
  // 기본은 접힌 스파인 — 펼침은 명시적 선택으로만 유지된다(전주가 본문 도달을 밀지 않도록).
  try {
    const stored = localStorage.getItem(OUTLINE_COLLAPSED_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function writeOutlineCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(OUTLINE_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage is optional.
  }
}

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { getT, useConsoleLocale, useT } from "../i18n/index.js";
import { useConsoleState } from "../hooks/use-store.js";
import {
  getCodexReaderHistoryState,
  mountNavigatorInto,
  mountReaderInto,
  navigateCodexReaderHistory,
  refreshCodexHealth,
  refreshCodexLocale,
  restoreCodexReaderSession,
  saveReaderScroll,
  setNavigatorTagFilter,
  setNavigatorTheater,
  setOnRequestOpenReader,
  subscribeCodexReaderHistory,
  teardownCodex,
  teardownReaderNodes,
} from "../codex-host.js";
import { closeCodexReader, expandCodexReader, openCodexReader } from "../store.js";
import { installCodexLiveRevalidation, revalidateCodexNow } from "../codex/live.js";
import { loadInitialData } from "../codex/state.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CodexWorkspaceState {
  readonly contextKey: string;
  readonly hasWiki: boolean;
  readonly id: string | null;
}

let lastCodexContextKey: string | null = null;
let lastResolvedWorkspace: CodexWorkspaceState | null = null;

/**
 * 덱(확대 시트)이 리더 fetch에 쓸 codex workspace id — Theater id가 아니라
 * 레일 패널이 해석해 둔 12-hex id여야 /console/codex/w/ 라우터가 인식한다.
 * 덱은 항상 레일의 확대 버튼을 거쳐 열리므로 해석 결과가 이미 따뜻하다.
 */
export function resolvedCodexWorkspaceIdFor(theaterId: string | null): string | null {
  const contextKey = theaterId ?? "";
  if (lastResolvedWorkspace && lastResolvedWorkspace.contextKey === contextKey && lastResolvedWorkspace.hasWiki) {
    return lastResolvedWorkspace.id;
  }
  return null;
}

// ─── Rail panel descriptor ───────────────────────────────────────────────────

export const codexPanel: RailPanelDescriptor = {
  id: "codex",
  title: (locale: ConsoleLocale) => getT(locale)("rail.codex.title"),
  defaultWidth: 420,
  icon: () => <CodexIcon />,
  render: (ctx) => <CodexRailPanel theaterId={ctx.theaterId} />,
};

// ─── Components ───────────────────────────────────────────────────────────────

function CodexRailPanel({ theaterId }: { readonly theaterId: string | null }) {
  const t = useT();
  const history = useSyncExternalStore(
    subscribeCodexReaderHistory,
    getCodexReaderHistoryState,
    getCodexReaderHistoryState,
  );
  const locale = useConsoleLocale();
  const state = useConsoleState();
  const navRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const latestContextKeyRef = useRef("");
  const localeRef = useRef(locale);
  const contextKey = theaterId ?? "";
  const [workspace, setWorkspace] = useState<CodexWorkspaceState | null>(
    lastResolvedWorkspace && lastResolvedWorkspace.contextKey === contextKey
      ? lastResolvedWorkspace
      : null,
  );
  const [outlineCollapsed, setOutlineCollapsed] = useState(readOutlineCollapsed);
  const [activeSection, setActiveSection] = useState("");

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const expanded = state.codexReaderExpanded;
  const activeTheater = state.theaters.find((t) => t.id === state.activeTheaterId) ?? null;
  const hasTheaters = state.theaters.length > 0;
  const workspaceId = workspace?.contextKey === contextKey && workspace.hasWiki ? workspace.id : null;
  const shouldMountCodex = workspaceId !== null;

  const readerKey = reader
    ? `${reader.kind}:${reader.kind === "entry" ? reader.entryId : reader.kind === "drydock" ? (reader.patchId ?? "") : reader.kind === "conflicts" ? (reader.id ?? "") : (reader.templateId ?? "")}`
    : null;

  // 실제 Theater가 바뀐 경우에만 이전 reader를 닫고, 같은 패널 재마운트 상태는 보존한다.
  useEffect(() => {
    latestContextKeyRef.current = contextKey;
    if (lastCodexContextKey !== null && lastCodexContextKey !== contextKey) {
      closeCodexReader();
    }
    lastCodexContextKey = contextKey;
    if (!theaterId) {
      const nextWorkspace = { contextKey, hasWiki: false, id: null };
      lastResolvedWorkspace = nextWorkspace;
      setWorkspace(nextWorkspace);
      return;
    }
    void resolveCodexWorkspace(theaterId).then((result) => {
      if (latestContextKeyRef.current !== contextKey) return;
      const nextWorkspace = { contextKey, ...result };
      lastResolvedWorkspace = nextWorkspace;
      setWorkspace(nextWorkspace);
    }).catch(() => {
      if (latestContextKeyRef.current !== contextKey) return;
      const nextWorkspace = { contextKey, hasWiki: false, id: null };
      lastResolvedWorkspace = nextWorkspace;
      setWorkspace(nextWorkspace);
    });
  }, [contextKey, theaterId]);

  // 위키 없음이 확정된 경우에만 singleton을 정리한다. 다음 Theater를 해석하는 동안에는
  // destroy+remount하지 않고, 기존 host를 새 navigator 컨테이너로 relocate한다.
  useEffect(() => {
    if (workspace?.contextKey === contextKey && !workspace.hasWiki) teardownCodex();
  }, [contextKey, workspace]);

  // 패널 DOM이 detach되기 전에 현재 reader 위치를 싱글톤에 저장한다.
  useLayoutEffect(() => () => saveReaderScroll(), []);

  // navigator 마운트 + onRequest 등록 — hasReader 전환 시 navRef 컨테이너가 바뀌므로 재배치
  // locale을 deps에 넣어 로케일 전환 시 effect를 다시 돌린다(싱글톤은 재배치만; 문구는 refreshCodexLocale).
  useEffect(() => {
    if (!shouldMountCodex || !workspaceId) return;
    const node = navRef.current;
    if (!node) return;
    mountNavigatorInto(node, workspaceId);
    setOnRequestOpenReader((r) => {
      if (r.kind === "entry") openCodexReader({ kind: "entry", entryId: r.id });
      else if (r.kind === "drydock") openCodexReader({ kind: "drydock", patchId: r.patchId });
      else if (r.kind === "conflicts") openCodexReader({ kind: "conflicts", id: r.id });
      else if (r.kind === "schema") openCodexReader({ kind: "schema", templateId: r.templateId });
      // 덱이 열려 있는 동안의 카탈로그 선택은 덱 안에서 문서를 교체한다 —
      // openCodexReader가 expanded를 접으므로 즉시 되살린다(오버레이 콜백과 동일 문법).
      if (expanded) expandCodexReader();
    });
    return () => {
      setOnRequestOpenReader(null);
    };
  }, [shouldMountCodex, workspaceId, hasReader, expanded, locale]);

  // Theater 해석으로 결정된 workspace 전환 시 navigator 데이터 소스를 바꾸고,
  // 저장된 reader session은 최초 1회만 정상 entry 요청 경로로 복원한다.
  useEffect(() => {
    if (shouldMountCodex && workspaceId) {
      setNavigatorTheater(workspaceId);
      // 레일 탭을 떠났다 돌아온 경우 싱글턴은 재배치만 되고 다시 읽지 않는다 —
      // 자리를 비운 사이의 변화는 이벤트로도 오지 않았으므로 복귀는 곧 재검증이다.
      revalidateCodexNow();
      if (!hasReader && theaterId) {
        const entryId = restoreCodexReaderSession(theaterId);
        if (entryId) openCodexReader({ kind: "entry", entryId });
      }
    }
  }, [shouldMountCodex, workspaceId, theaterId]);

  // 창으로 돌아왔을 때의 재검증 — SSE가 끊겼다 붙는 사이의 변화는 이벤트로 오지 않는다.
  useEffect(() => installCodexLiveRevalidation(), []);

  // split reader mount — expanded=true면 오버레이가 처리 중이므로 건너뜀
  useEffect(() => {
    if (!shouldMountCodex || !workspaceId || !hasReader || expanded) return;
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
  }, [shouldMountCodex, workspaceId, hasReader, expanded, readerKey, locale]);

  // 접힌 아웃라인 스파인이 현재 섹션명을 되비추도록 스크롤 스파이의 활성 전환을 구독한다.
  useEffect(() => {
    const outline = outlineRef.current;
    if (!outline) return;
    const onActive = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      setActiveSection(detail?.text ?? "");
    };
    outline.addEventListener("codex-toc-active", onActive);
    // 덱(확대) 동안의 활성 전환 이벤트는 이 리스너 밖에서 지나간다 — 재부착 시점에
    // 재배치된 TOC의 활성 표식에서 상태를 다시 읽어 낡은 섹션명이 남지 않게 한다.
    // (리더 마운트 effect가 먼저 선언되어 TOC 재배치가 이 시점엔 끝나 있다.)
    const active = outline.querySelector<HTMLElement>('.codex-doc-toc-inline [aria-current="location"]');
    setActiveSection(active?.textContent ?? "");
    return () => outline.removeEventListener("codex-toc-active", onActive);
    // 아웃라인이 (재)마운트되는 모든 전이에서 다시 걸려야 한다 — 리더 마운트 effect와 같은 의존성.
  }, [shouldMountCodex, workspaceId, hasReader, expanded, readerKey]);

  // 로케일 변경 시 imperative DOM 문구를 갱신한다(문서·스크롤 보존).
  useEffect(() => {
    if (localeRef.current === locale) return;
    localeRef.current = locale;
    refreshCodexLocale();
  }, [locale]);

  // hasReader=false 시 reader 호스트 노드 정리
  useEffect(() => {
    if (!hasReader) teardownReaderNodes();
  }, [hasReader]);

  if (!shouldMountCodex) {
    return <CodexEmpty activeTheater={activeTheater} hasTheaters={hasTheaters} />;
  }

  if (!hasReader || expanded) {
    return <div ref={navRef} className="codex-rail-host" />;
  }

  return (
    <div className="codex-rail-host is-split">
      <div className="codex-doc-pane">
        <div className="codex-doc-pane-head">
          <ReaderHistoryButtons history={history} />
          <button
            className="codex-doc-expand"
            type="button"
            aria-label={t("rail.codex.expandAria")}
            data-codex-expand="true"
            onClick={expandCodexReader}
          >
            {t("rail.codex.expand")}
          </button>
          <button
            className="codex-reading-sheet-close"
            type="button"
            aria-label={t("rail.codex.closePaneAria")}
            onClick={closeCodexReader}
          >
            ✕
          </button>
        </div>
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
      <div ref={navRef} className="codex-nav-pane" />
    </div>
  );
}

function ReaderHistoryButtons({
  history,
}: {
  readonly history: { readonly canGoBack: boolean; readonly canGoForward: boolean };
}) {
  const t = useT();
  return (
    <div className="codex-reader-history">
      <button
        className="codex-reader-history-btn"
        type="button"
        aria-label={t("codex.nav.backAria")}
        disabled={!history.canGoBack}
        onClick={() => navigateCodexReaderHistory(-1)}
      >
        ←
      </button>
      <button
        className="codex-reader-history-btn"
        type="button"
        aria-label={t("codex.nav.forwardAria")}
        disabled={!history.canGoForward}
        onClick={() => navigateCodexReaderHistory(1)}
      >
        →
      </button>
    </div>
  );
}

function CodexEmpty({
  activeTheater,
  hasTheaters,
}: {
  readonly activeTheater: { readonly label: string } | null;
  readonly hasTheaters: boolean;
}) {
  const t = useT();
  if (!hasTheaters) {
    return (
      <section className="codex-empty-state">
        <p className="codex-empty-eyebrow">{t("rail.codex.emptyEyebrow")}</p>
        <h1>{t("rail.codex.addTheater")}</h1>
        <p>{t("rail.codex.addTheaterHint")}</p>
      </section>
    );
  }
  return (
    <section className="codex-empty-state">
      <p className="codex-empty-eyebrow">{t("rail.codex.unavailable")}</p>
      <h1>{activeTheater?.label || t("rail.codex.thisTheater")}</h1>
      <p>{t("rail.codex.wikiUnavailable")}</p>
    </section>
  );
}

async function resolveCodexWorkspace(theaterId: string): Promise<Omit<CodexWorkspaceState, "contextKey">> {
  const response = await fetch(`/api/v1/theaters/${encodeURIComponent(theaterId)}/codex-workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) throw new Error("codex_workspace_unavailable");
  return assertCodexWorkspace(await response.json());
}

function readOutlineCollapsed(): boolean {
  // 기본은 접힌 스파인 — 펼침은 명시적 선택으로만 유지된다(전주가 본문 도달을 밀지 않도록).
  try {
    const stored = localStorage.getItem("fleet.codex.outline.collapsed");
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function writeOutlineCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem("fleet.codex.outline.collapsed", String(collapsed));
  } catch {
    // Storage is optional.
  }
}

function assertCodexWorkspace(value: unknown): Omit<CodexWorkspaceState, "contextKey"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_codex_workspace");
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).length !== 2 || typeof payload.hasWiki !== "boolean") throw new Error("invalid_codex_workspace");
  if (payload.hasWiki && typeof payload.id === "string" && /^[0-9a-f]{12}$/.test(payload.id)) {
    return { hasWiki: true, id: payload.id };
  }
  if (!payload.hasWiki && payload.id === null) return { hasWiki: false, id: null };
  throw new Error("invalid_codex_workspace");
}

function CodexIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.16" />
      <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21" />
      <path d="M12 8.6 14.2 12 12 15.4 9.8 12Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

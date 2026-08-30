import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";

import { getT, useT } from "./i18n/index.js";
import { useConsoleLocale } from "./reader-store.js";
import {
  consumeRestoredReaderExpanded,
  getCodexReaderHistoryState,
  mountNavigatorInto,
  mountReaderInto,
  navigateCodexReaderHistory,
  refreshCodexHealth,
  refreshCodexLocale,
  restoreCodexReaderSession,
  setNavigatorTagFilter,
  setNavigatorTheater,
  setOnRequestOpenReader,
  subscribeCodexReaderHistory,
  teardownCodex,
  teardownReaderNodes,
} from "./codex-host.js";
import { CODEX_READER_PANE_ID, shouldStandReaderColumn } from "./codex-reader-pane.js";
import {
  lastCodexScope,
  lastResolvedCodexWorkspace,
  publishResolvedWorkspace,
  rememberCodexScope,
  type CodexWorkspaceState,
} from "./workspace-store.js";
import { closeCodexReader, expandCodexReader, openCodexReader, useReaderState } from "./reader-store.js";
import { fetchSearch } from "./codex/api.js";
import { openCodexRailPanel, openCodexReaderByAddress } from "./host.js";
import { installCodexLiveRevalidation, revalidateCodexNow } from "./codex/live.js";
import { loadInitialData } from "./codex/state.js";

// ─── Types ───────────────────────────────────────────────────────────────────

function hasCodexEntryInUrl(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("codex") !== null;
}

// ─── Rail panel descriptor ───────────────────────────────────────────────────

export const codexEntry: RailEntryDescriptor = {
  id: "codex",
  title: (locale) => getT(locale)("rail.codex.title"),
  icon: () => <CodexIcon />,
  panes: ["codex", CODEX_READER_PANE_ID],
};

/** 카탈로그 — 표면이 열리면 이 열이 선다. 문서는 옆에 서는 별개의 열이다. */
export const codexPane: PaneDescriptor = {
  id: "codex",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("rail.codex.title"),
  render: (ctx) => <CodexRailPanel ctx={ctx} />,
  defaultWidth: 420,
  minWidth: 248,
  search: async ({ query, theaterId, limit, signal, language }) => {
    if (!theaterId) return [];
    const response = await fetchSearch(theaterId, { q: query, limit, signal });
    const t = getT(language);
    return response.entries.map((entry) => ({
      id: entry.id,
      title: entry.title || entry.id,
      subtitle: entry.tags.length > 0 ? entry.tags.join(" · ") : t("rail.codex.title"),
      activate: () => {
        // 팔레트에서 열면 패널이 아직 서 있지 않을 수 있다 — 공유 링크와 같은 자리다.
        openCodexRailPanel();
        // 리더를 직접 열지 않고 **주소로** 연다. 패널은 마운트 직후 Theater가 확정되기 전
        // 리더를 한 번 닫으므로, 직접 연 문서는 그 닫힘에 지워진다. 주소는 그 구간을 건너
        // 살아남았다가 Theater가 준비된 뒤 적용된다 — 공유 링크가 그렇게 동작한다.
        openCodexReaderByAddress(entry.id, theaterId);
      },
    }));
  },
};

// ─── Components ───────────────────────────────────────────────────────────────

function CodexRailPanel({ ctx }: { readonly ctx: PaneContext }) {
  const theaterId = ctx.theaterId;
  const locale = useConsoleLocale();
  const state = useReaderState();
  const navRef = useRef<HTMLDivElement>(null);
  const latestContextKeyRef = useRef("");
  const localeRef = useRef(locale);
  const contextKey = theaterId ?? "";
  const [workspace, setWorkspace] = useState<CodexWorkspaceState | null>(() => {
    const known = lastResolvedCodexWorkspace();
    return known && known.contextKey === contextKey ? known : null;
  });

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const expanded = state.codexReaderExpanded;
  const activeTheater = state.theaters.find((t) => t.id === state.activeTheaterId) ?? null;
  const hasTheaters = state.theaters.length > 0;
  const workspaceId = workspace?.contextKey === contextKey && workspace.hasWiki ? workspace.id : null;
  const shouldMountCodex = workspaceId !== null;

  // 문서 열은 여기서 세우고 여기서 거둔다. 두 조건은 서로 배타적이라(읽을 것이 있고 확대가
  // 아닐 때만 열이 선다) 한쪽이 다른 쪽을 되돌리는 다툼이 생기지 않는다. 폭은 표면이 진다 —
  // 예전의 `requestExtraWidth`는 detail이 자기 `defaultWidth`를 들고 서는 것으로 대체됐다.
  const panes = ctx.panes;
  useEffect(() => {
    if (shouldStandReaderColumn(state)) panes.open({ paneId: CODEX_READER_PANE_ID, focus: false });
    else panes.close(CODEX_READER_PANE_ID);
  }, [panes, state]);

  // 실제 Theater가 바뀐 경우에만 이전 reader를 닫고, 같은 패널 재마운트 상태는 보존한다.
  //
  // "아직 Theater를 모른다"(빈 contextKey)에서 실제 Theater로 가는 것은 **바뀐 것이 아니라
  // 정해진 것**이다. 그것을 변경으로 읽으면, 주소가 막 열어 둔 문서를 부팅 도중에 닫아
  // 버린다 — 공유 링크가 확대로 들어와도 축소로 되돌아가던 원인이 이것이었다.
  useEffect(() => {
    latestContextKeyRef.current = contextKey;
    const previousScope = lastCodexScope();
    const settledFromUnknown = previousScope === "";
    if (previousScope !== null && !settledFromUnknown && previousScope !== contextKey) {
      closeCodexReader();
    }
    rememberCodexScope(contextKey);
    if (!theaterId) {
      const nextWorkspace = { contextKey, hasWiki: false, id: null };
      publishResolvedWorkspace(nextWorkspace);
      setWorkspace(nextWorkspace);
      return;
    }
    void resolveCodexWorkspace(theaterId).then((result) => {
      if (latestContextKeyRef.current !== contextKey) return;
      const nextWorkspace = { contextKey, ...result };
      publishResolvedWorkspace(nextWorkspace);
      setWorkspace(nextWorkspace);
    }).catch(() => {
      if (latestContextKeyRef.current !== contextKey) return;
      const nextWorkspace = { contextKey, hasWiki: false, id: null };
      publishResolvedWorkspace(nextWorkspace);
      setWorkspace(nextWorkspace);
    });
  }, [contextKey, theaterId]);

  // 위키 없음이 확정된 경우에만 singleton을 정리한다. 다음 Theater를 해석하는 동안에는
  // destroy+remount하지 않고, 기존 host를 새 navigator 컨테이너로 relocate한다.
  useEffect(() => {
    if (workspace?.contextKey === contextKey && !workspace.hasWiki) teardownCodex();
  }, [contextKey, workspace]);

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
        // 세션은 항상 읽는다 — 읽던 자리(scrollTop)를 아는 유일한 경로이기 때문이다.
        // 어떤 문서를 열지는 주소가 지목했으면 주소가 이기고, 저장된 자리는 그 문서가
        // 세션의 문서와 같을 때에만 쓰인다(mountReaderInto의 pendingSessionRestore).
        const entryId = restoreCodexReaderSession(theaterId);
        if (entryId && !hasCodexEntryInUrl()) {
          openCodexReader({ kind: "entry", entryId });
          // 확대는 리더 세션의 일부다 — 떠날 때의 화면으로 돌아온다.
          if (consumeRestoredReaderExpanded()) expandCodexReader();
        }
      }
    }
  }, [shouldMountCodex, workspaceId, theaterId]);

  // 창으로 돌아왔을 때의 재검증 — SSE가 끊겼다 붙는 사이의 변화는 이벤트로 오지 않는다.
  useEffect(() => installCodexLiveRevalidation(), []);

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

  return <div ref={navRef} className="codex-rail-host" />;
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
  // 플러그인 라우트는 자기 이름공간에 산다 — `/api/v1/theaters/...`는 코어가 소유한 경로라
  // 플러그인이 그 밑에 끼어들 수 없다. Theater는 경로가 아니라 본문이 싣는다(workspace-routes).
  const response = await fetch("/api/v1/plugins/codex/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theaterId }),
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

import { useEffect, useRef, useState } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import type { PaneContext, PaneDescriptor } from "../../workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../workspace/shared/rail.js";

import { getT, useT } from "./i18n/index.js";
import { useConsoleLocale } from "./reader-store.js";
import { readCommodoreList } from "../../commodore/client/commodore-list.js";
import {
  consumeRestoredReaderExpanded,
  mountNavigatorInto,
  refreshCodexLocale,
  restoreCodexReaderSession,
  setNavigatorTheater,
  setOnRequestOpenReader,
  teardownCodex,
  teardownReaderNodes,
} from "./codex-host.js";
import { CODEX_READER_PANE_ID, shouldStandReaderColumn } from "./codex-reader-pane.js";
import {
  codexWorkspaceContextKey,
  lastCodexScope,
  lastResolvedCodexWorkspace,
  publishResolvedWorkspace,
  rememberCodexScope,
  resolveCodexWorkspace,
  type CodexWorkspaceState,
} from "./workspace-store.js";
import { closeCodexReader, expandCodexReader, getReaderState, openCodexReader, resetCodexReaderContext, useReaderState } from "./reader-store.js";
import { readReaderSession, validateReaderEntry } from "./reader-session.js";
import { fetchSearch } from "./codex/api.js";
import { openCodexRailPanel, openCodexReaderByAddress } from "./host.js";
import { installCodexLiveRevalidation, revalidateCodexNow } from "./codex/live.js";
import { loadInitialData } from "./codex/state.js";
import { MobileWikiList } from "./mobile.js";

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
  // 모바일 홈 바로가기 — 목표 다음 위키.
  // 모바일 바로가기·「플러그인」 화면의 아이콘 — 시안 아이콘 한 벌(impl-spec §A)이다. 데스크톱 레일 아이콘은 그대로.
  mobile: { destination: { order: 30, label: (locale) => getT(locale)("mobile.wiki.title") }, icon: () => <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h9" /></svg> },
  handles: {
    openWikiEntry: (request, host) => {
      if (!readCommodoreList().some((commodore) => commodore.commodoreId === request.theaterId)) return { ok: false, reason: "not_found" };
      host.navigation.setSearchParams({ codex: request.entryId, codexTheater: request.theaterId, codexView: null }, { replace: request.replace === true });
      return { ok: true };
    },
  },
};

/** 카탈로그 — 표면이 열리면 이 열이 선다. 문서는 옆에 서는 별개의 열이다. */
export const codexPane: PaneDescriptor = {
  id: "codex",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("rail.codex.title"),
  // 모바일 목적지 화면에서는 호스트가 막대 창구(mobileBar)를 싣는다 — 그때만 모바일 목록이 선다.
  render: (ctx) => (ctx.mobileBar ? <MobileWikiList ctx={ctx} /> : <CodexRailPanel ctx={ctx} />),
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
  const commodoreId = ctx.commodoreId;
  const contextKey = codexWorkspaceContextKey(commodoreId);
  const [workspace, setWorkspace] = useState<(CodexWorkspaceState & { readonly failed?: boolean }) | null>(() => {
    const known = lastResolvedCodexWorkspace();
    return known && known.contextKey === contextKey && known.hasWiki ? known : null;
  });

  const reader = state.codexReader;
  const hasReader = reader !== null;
  const expanded = state.codexReaderExpanded;
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

  // Wiki 소유 스코프가 바뀐 경우에만 이전 reader를 닫고, 같은 패널 재마운트 상태는 보존한다.
  //
  // "아직 맥락을 모른다"(빈 contextKey)에서 실제 소유자로 가는 것은 **바뀐 것이 아니라
  // 정해진 것**이다. 그것을 변경으로 읽으면, 주소가 막 열어 둔 문서를 부팅 도중에 닫아
  // 버린다 — 공유 링크가 확대로 들어와도 축소로 되돌아가던 원인이 이것이었다.
  useEffect(() => {
    latestContextKeyRef.current = contextKey;
    const previousScope = lastCodexScope();
    const settledFromUnknown = previousScope === "";
    if (previousScope !== null && !settledFromUnknown && previousScope !== contextKey) {
      resetCodexReaderContext();
    }
    rememberCodexScope(contextKey);
    let stopped = false;
    void resolveCodexWorkspace(commodoreId).then((result) => {
      if (stopped || latestContextKeyRef.current !== contextKey) return;
      const nextWorkspace = { contextKey, theaterId, ...result };
      publishResolvedWorkspace(nextWorkspace);
      setWorkspace(nextWorkspace);
    }).catch(() => {
      if (stopped || latestContextKeyRef.current !== contextKey) return;
      const nextWorkspace = { contextKey, theaterId, hasWiki: false, id: null };
      publishResolvedWorkspace(nextWorkspace);
      setWorkspace({ ...nextWorkspace, failed: true });
    });
    return () => { stopped = true; };
  }, [contextKey, theaterId, commodoreId]);

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
    const controller = new AbortController();
    if (shouldMountCodex && workspaceId) {
      setNavigatorTheater(workspaceId);
      // 레일 탭을 떠났다 돌아온 경우 싱글턴은 재배치만 되고 다시 읽지 않는다 —
      // 자리를 비운 사이의 변화는 이벤트로도 오지 않았으므로 복귀는 곧 재검증이다.
      revalidateCodexNow();
      if (!hasReader && theaterId && !hasCodexEntryInUrl()) {
        const session = readReaderSession(contextKey);
        if (session) {
          void validateReaderEntry(contextKey, workspaceId, session.entryId, controller.signal).then((exists) => {
            if (!exists || controller.signal.aborted || latestContextKeyRef.current !== contextKey
              || getReaderState().codexReader || hasCodexEntryInUrl()) return;
            const entryId = restoreCodexReaderSession(contextKey);
            if (entryId !== session.entryId) return;
            openCodexReader({ kind: "entry", entryId });
            if (consumeRestoredReaderExpanded()) expandCodexReader();
          }).catch(() => {
            // 통신 실패 때는 세션을 보존하고, 검증되지 않은 문서는 열지 않는다.
          });
        }
      }
    }
    return () => controller.abort();
  }, [shouldMountCodex, workspaceId, theaterId, contextKey]);

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
    const kind = !contextKey ? "none" : workspace?.contextKey !== contextKey ? "loading" : workspace.failed ? "failed" : "none";
    return <div className="codex-panel-body"><CodexEmpty kind={kind} /></div>;
  }

  return <div className="codex-panel-body"><div ref={navRef} className="codex-rail-host" /></div>;
}

function CodexEmpty({ kind }: { readonly kind: "loading" | "none" | "failed" }) {
  const t = useT();
  // hasWiki:false는 소유자를 못 정한 상태다. 항목이 없는 정상 위키는 카탈로그가 따로 안내한다.
  return (
    <section className="codex-empty-state" role={kind === "failed" ? "alert" : "status"}>
      <p className="codex-empty-eyebrow">{t(kind === "failed" ? "rail.codex.unavailable" : "rail.codex.emptyEyebrow")}</p>
      <h1>{t(kind === "none" ? "rail.codex.chooseCommodore" : "rail.codex.thisCommodore")}</h1>
      <p>{t(kind === "loading" ? "common.loading" : kind === "failed" ? "rail.codex.wikiUnavailable" : "rail.codex.chooseCommodoreHint")}</p>
    </section>
  );
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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { PaneContext } from "@fleet-console/sdk/pane";

import type { SearchEntry } from "../server/codex/contracts.js";
import { fetchDrydock, fetchSearch } from "./codex/api.js";
import { CODEX_READER_PANE_ID } from "./codex-reader-pane.js";
import { getT } from "./i18n/index.js";
import { openCodexReader } from "./reader-store.js";
import { publishResolvedWorkspace, resolveCodexWorkspace } from "./workspace-store.js";
import "./mobile.css";

/**
 * 모바일 목적지 「위키」(S-44) — 검토 대기 한 줄과 항목 목록. 호스트가 페인 컨텍스트에 `mobileBar`를 실을 때만 선다.
 * 항목·검토 대기를 누르면 데스크톱과 같은 리더 열(`codex-reader`)이 상세로 선다 — 본문은 리더가 그린다.
 * 데이터는 데스크톱 카탈로그와 같은 창구(`search`·`drydock`)에서 읽는다.
 */

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly entries: readonly SearchEntry[]; readonly pending: number };

const Icon = ({ children, size = 22 }: { readonly children: ReactNode; readonly size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const WikiIcon = () => <Icon><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13z" /></Icon>;

export function MobileWikiList({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const { theaterId, mobileBar, panes, visible, consoleState } = ctx;
  const label = useSyncExternalStore(consoleState.subscribe, () => consoleState.getTheaters().find((theater) => theater.id === theaterId)?.label ?? "", () => "");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const generation = useRef(0);
  const title = t("mobile.wiki.title");

  useEffect(() => { if (visible) mobileBar?.set({ title, ...(label ? { subtitle: label } : {}), depth: 0 }); }, [mobileBar, visible, title, label]);

  const refresh = useCallback(() => {
    if (!theaterId) return;
    const id = ++generation.current;
    const current = () => id === generation.current;
    void resolveCodexWorkspace(theaterId)
      .then(async (workspace) => {
        if (!current()) return;
        // 리더 열이 같은 해석을 읽는다 — 데스크톱 카탈로그와 같은 발행이다.
        publishResolvedWorkspace({ contextKey: theaterId, ...workspace });
        if (!workspace.hasWiki || !workspace.id) { setLoad({ kind: "none" }); return; }
        const [search, drydock] = await Promise.all([fetchSearch(workspace.id), fetchDrydock(workspace.id, "pending").catch(() => null)]);
        if (current()) setLoad({ kind: "ready", entries: search.entries, pending: drydock?.pendingCount ?? 0 });
      })
      .catch(() => { if (current()) setLoad({ kind: "failed" }); });
  }, [theaterId]);

  // 처음과, 문서에서 돌아와 다시 보일 때 — 자리를 비운 사이의 변화는 돌아온 순간 다시 읽는다.
  useEffect(() => { setLoad({ kind: "loading" }); }, [theaterId]);
  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);

  const openEntry = (entryId: string) => { openCodexReader({ kind: "entry", entryId }); panes.open({ paneId: CODEX_READER_PANE_ID }); };
  const openReview = () => { openCodexReader({ kind: "drydock" }); panes.open({ paneId: CODEX_READER_PANE_ID }); };

  return (
    <div className="codex-m">
      <div className="codex-m-pad">
        {load.kind === "loading" ? <p className="codex-m-note" role="status">{t("mobile.wiki.loading")}</p> : null}
        {load.kind === "failed" ? <button type="button" className="codex-m-note" onClick={refresh}>{t("mobile.wiki.failed")}</button> : null}
        {load.kind === "none" ? <p className="codex-m-note">{t("rail.codex.wikiUnavailable")}</p> : null}
        {load.kind === "ready" && load.pending > 0 ? (
          <div className="codex-m-grp">
            <button type="button" className="codex-m-row is-two" onClick={openReview}>
              <span className="codex-m-sg" aria-hidden="true" />
              <span className="codex-m-tx">{t("mobile.wiki.review")}<small>{t("mobile.wiki.reviewCount", { count: load.pending })}</small></span>
            </button>
          </div>
        ) : null}
        {load.kind === "ready" ? (
          <>
            <h2 className="codex-m-glab">{t("mobile.wiki.items")}</h2>
            {load.entries.length === 0 ? <p className="codex-m-note">{t("mobile.wiki.empty")}</p> : (
              <div className="codex-m-grp">
                {load.entries.map((entry) => (
                  <button key={entry.id} type="button" className="codex-m-row" onClick={() => openEntry(entry.id)}>
                    <span className="codex-m-icon"><WikiIcon /></span>
                    <span className="codex-m-tx">{entry.title}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

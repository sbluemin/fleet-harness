import { useEffect, useState } from "react";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { PaneContext, PaneDescriptor } from "../../workspace/shared/pane.js";
import type { RailEntryDescriptor } from "../../workspace/shared/rail.js";
import type { KnowledgeFolderAction, KnowledgeFolderResult } from "../shared/contracts/knowledge-folder.js";
import { getT } from "./i18n/index.js";
import "./knowledge-folder.css";

async function requestFolder(api: ClientApiCapability, commodoreId: string, action: KnowledgeFolderAction, signal?: AbortSignal): Promise<KnowledgeFolderResult> {
  const response = await api.fetch("/api/v1/commodore/knowledge-folder", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commodoreId, action }), ...(signal ? { signal } : {}),
  });
  if (!response.ok) return { status: "unavailable" };
  return await response.json() as KnowledgeFolderResult;
}

/** 익숙한 입구만 남긴다. 데스크톱은 호스트 폴더 열기, 모바일 목적지는 표시 전용 페인이다. */
export const knowledgeFolderEntry: RailEntryDescriptor = {
  id: "codex",
  title: "Codex",
  tooltip: {
    title: (locale) => getT(locale)("commodore.knowledge.retired"),
    body: (locale) => getT(locale)("commodore.knowledge.reason"),
  },
  icon: () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" opacity="0.16" />
    <path d="M12 3v3.6M12 17.4V21M3 12h3.6M17.4 12H21" />
    <path d="M12 8.6 14.2 12 12 15.4 9.8 12Z" fill="currentColor" stroke="none" />
  </svg>,
  opensWithoutTheater: true,
  requiresCommodore: true,
  keepsObjectiveActive: true,
  panes: ["codex"],
  activate: (ctx) => {
    const commodoreId = ctx.commodoreId;
    if (!commodoreId) return;
    void requestFolder(ctx.api, commodoreId, "open").then((result) => {
      if (result.status !== "opened") ctx.rail?.open("codex", { status: result.status });
    }).catch(() => ctx.rail?.open("codex", { status: "unavailable" }));
  },
  mobile: {
    destination: { order: 30, label: (locale) => getT(locale)("commodore.knowledge.shortcut") },
    icon: () => <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h9" /></svg>,
  },
};

export const knowledgeFolderPane: PaneDescriptor = {
  id: "codex", role: "primary", mounts: ["rail"], widthClass: "standard",
  title: (ctx) => getT(ctx.language)("commodore.knowledge.retired"),
  render: (ctx) => <KnowledgeFolderPane key={`${ctx.commodoreId ?? ""}:${Boolean(ctx.mobileBar)}:${ctx.params.status ?? ""}`} ctx={ctx} />,
};

function KnowledgeFolderPane({ ctx }: { readonly ctx: PaneContext }) {
  const t = getT(ctx.language);
  const mobile = Boolean(ctx.mobileBar);
  const commodoreId = ctx.commodoreId;
  const api = ctx.api;
  const [result, setResult] = useState<KnowledgeFolderResult | null>(null);
  useEffect(() => {
    // 모바일 셸이 넘긴 mobileBar만 판정한다. 데스크톱 실패 안내는 경로를 요청하지 않는다.
    if (!mobile || !commodoreId) return;
    const controller = new AbortController();
    void requestFolder(api, commodoreId, "display", controller.signal).then((value) => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(() => { if (!controller.signal.aborted) setResult({ status: "unavailable" }); });
    return () => controller.abort();
  }, [api, commodoreId, mobile]);
  const message = !commodoreId ? "commodore.knowledge.choose"
    : !mobile ? ctx.params.status === "missing" ? "commodore.knowledge.missing" : "commodore.knowledge.unavailable"
    : result === null ? "commodore.knowledge.loading"
    : result.status === "display" ? result.exists ? "commodore.knowledge.onComputer" : "commodore.knowledge.missing"
    : "commodore.knowledge.unavailable";
  return <section className="commodore-knowledge-folder">
    <h2>{t("commodore.knowledge.retired")}</h2>
    <p>{t("commodore.knowledge.mobileReason")}</p>
    {result?.status === "display" ? <code className="commodore-knowledge-path">{result.displayPath}</code> : null}
    <p role="status">{t(message)}</p>
  </section>;
}

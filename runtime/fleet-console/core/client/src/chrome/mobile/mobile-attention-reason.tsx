import { useEffect, useState } from "react";

import { useT } from "../../i18n/index.js";
import type { MobileAttentionRow } from "./mobile-destinations.js";

/** 1초마다 갱신되는 지금 — 허용 요청 남은 시간이 있을 때만 돈다. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 확인 필요 행의 보조 줄 — 종류마다 다른 말을 한다(S-35). */
export function useAttentionReason(row: MobileAttentionRow): string {
  const t = useT();
  const expiresAt = row.kind === "operation" ? row.request?.expiresAt : undefined;
  const now = useNow(expiresAt !== undefined);
  if (row.kind === "plugin") return row.item.reason;
  if (expiresAt !== undefined) return t("mobile.attention.useRequest", { time: formatRemaining(expiresAt - now) });
  return t("mobile.attention.awaiting");
}

/** 보조 줄 텍스트만 그리는 작은 조각 — 행마다 훅을 쓰기 위한 경계. */
export function AttentionReason({ row }: { readonly row: MobileAttentionRow }) {
  return <>{useAttentionReason(row)}</>;
}

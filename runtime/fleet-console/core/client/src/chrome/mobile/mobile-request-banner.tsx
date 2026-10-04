import { useEffect, useRef, useState } from "react";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useAllOperationUseRequests, type OperationUseRequest } from "../../../../../features/computer-use/client/computer-screen-share.js";
import { useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { formatRemaining } from "./mobile-attention-reason.js";

const SHOW_MS = 6000;

/**
 * 위에서 내려오는 알림(S-32) — 지금 보고 있지 않은 Operation에 허용 요청이 새로 오면 6초 동안 선다.
 * 접힌 뒤에도 ≡ 점과 드로어 「확인 필요」에 남는다. 그 Operation을 보고 있으면 띄우지 않는다.
 */
export function MobileRequestBanner({ state, viewingOperationId, onOpen }: {
  readonly state: ConsoleState;
  /** 지금 화면에 Operation이 서 있다면 그 id — 홈이 아니면 null. */
  readonly viewingOperationId: string | null;
  readonly onOpen: (operationId: string) => void;
}) {
  const t = useT();
  const requests = useAllOperationUseRequests();
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  const [shown, setShown] = useState<OperationUseRequest | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const ids = new Set(requests.map((request) => request.id));
    const previous = seenRef.current;
    seenRef.current = ids;
    // 처음 읽은 스냅샷에 이미 있던 요청은 새로 온 것이 아니다.
    if (previous === null) return;
    const fresh = requests.filter((request) => !previous.has(request.id) && request.operationId !== viewingOperationId);
    const latest = fresh.at(-1);
    if (latest) { setShown(latest); setLeaving(false); }
  }, [requests, viewingOperationId]);

  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const fold = window.setTimeout(() => setLeaving(true), SHOW_MS);
    const gone = window.setTimeout(() => setShown(null), SHOW_MS + 200);
    return () => { window.clearInterval(tick); window.clearTimeout(fold); window.clearTimeout(gone); };
  }, [shown]);

  // 그 Operation을 열면 알림은 할 일이 끝났다.
  useEffect(() => { if (shown && shown.operationId === viewingOperationId) setShown(null); }, [shown, viewingOperationId]);

  if (!shown) return null;
  const operation = state.operations.find((item) => item.id === shown.operationId);
  const title = operation?.title ?? "";
  const kind = shown.capability === "computer" ? t("mobile.banner.computer", { time: formatRemaining(shown.expiresAt - now) }) : t("mobile.banner.console", { time: formatRemaining(shown.expiresAt - now) });
  return (
    <div className={`mobile-request-banner${leaving ? " is-leaving" : ""}`} role="status" aria-live="polite">
      <span className={statusGlyphClassName("awaiting")} aria-hidden="true" />
      <span className="mobile-request-banner-copy">
        <span>{t("mobile.banner.title", { title })}</span>
        <small>{kind}</small>
      </span>
      <button type="button" onClick={() => { setShown(null); onOpen(shown.operationId); }}>{t("mobile.banner.open")}</button>
    </div>
  );
}

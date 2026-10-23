import { useEffect, useRef, useState } from "react";

import { useAllObjectiveUseRequests, type ObjectiveUseRequest } from "../../../../../features/computer-use/client/computer-screen-share.js";
import { ObjectiveStatusIcon } from "../../../../../features/execution/client/components/objective-status-icon.js";
import { resolveObjectiveActivity, resolveObjectiveMarkVisual } from "../../../../../features/execution/client/objective-activity.js";
import { getIdleArrivalIds } from "../../../../../features/execution/client/objective-marks.js";
import { useT } from "../../i18n/index.js";
import type { ConsoleState } from "../../integration/types.js";
import { formatRemaining } from "./mobile-attention-reason.js";

const SHOW_MS = 6000;

/**
 * 위에서 내려오는 알림(S-32) — 지금 보고 있지 않은 Objective에 허용 요청이 새로 오면 6초 동안 선다.
 * 접힌 뒤에도 홈 맨 위 「확인 필요」 묶음에 남는다. 그 Objective을 보고 있으면 띄우지 않는다.
 */
export function MobileRequestBanner({ state, viewingObjectiveId, onOpen }: {
  readonly state: ConsoleState;
  /** 지금 화면에 Objective이 서 있다면 그 id — 홈이 아니면 null. */
  readonly viewingObjectiveId: string | null;
  readonly onOpen: (objectiveId: string) => void;
}) {
  const t = useT();
  const requests = useAllObjectiveUseRequests();
  const seenRef = useRef<ReadonlySet<string> | null>(null);
  const [shown, setShown] = useState<ObjectiveUseRequest | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const ids = new Set(requests.map((request) => request.id));
    const previous = seenRef.current;
    seenRef.current = ids;
    // 처음 읽은 스냅샷에 이미 있던 요청은 새로 온 것이 아니다.
    if (previous === null) return;
    const fresh = requests.filter((request) => !previous.has(request.id) && request.objectiveId !== viewingObjectiveId);
    const latest = fresh.at(-1);
    if (latest) { setShown(latest); setLeaving(false); }
  }, [requests, viewingObjectiveId]);

  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const fold = window.setTimeout(() => setLeaving(true), SHOW_MS);
    const gone = window.setTimeout(() => setShown(null), SHOW_MS + 200);
    return () => { window.clearInterval(tick); window.clearTimeout(fold); window.clearTimeout(gone); };
  }, [shown]);

  // 그 Objective을 열면 알림은 할 일이 끝났다.
  useEffect(() => { if (shown && shown.objectiveId === viewingObjectiveId) setShown(null); }, [shown, viewingObjectiveId]);

  if (!shown) return null;
  const objectiveRecord = state.objectiveRecords.find((item) => item.id === shown.objectiveId);
  const title = objectiveRecord?.title ?? "";
  const kind = shown.capability === "computer" ? t("mobile.banner.computer", { time: formatRemaining(shown.expiresAt - now) }) : t("mobile.banner.console", { time: formatRemaining(shown.expiresAt - now) });
  return (
    <div className={`mobile-request-banner${leaving ? " is-leaving" : ""}`} role="status" aria-live="polite">
      {objectiveRecord ? <ObjectiveStatusIcon objectiveRecord={objectiveRecord} status={resolveObjectiveMarkVisual({ activity: resolveObjectiveActivity(objectiveRecord, state.objectiveRecordRuntime), objectiveId: objectiveRecord.id, idleArrivalIds: getIdleArrivalIds() })} size={28} decorative /> : null}
      <span className="mobile-request-banner-copy">
        <span>{t("mobile.banner.title", { title })}</span>
        <small>{kind}</small>
      </span>
      <button type="button" onClick={() => { setShown(null); onOpen(shown.objectiveId); }}>{t("mobile.banner.open")}</button>
    </div>
  );
}

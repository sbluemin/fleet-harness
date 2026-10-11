import { useEffect, useState } from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { Objective } from "../server/types.js";
import type { ObjectiveMessageKey } from "./i18n/index.js";

/**
 * 합쳐 온 목표의 출처 — 병합된 목표는 독립 목표로 남지 않고 받은 목표의 기록 안에만 남는다.
 * 브리핑 아래에 출처·누가·언제를 읽기 전용으로 적고, 옮겨 온 기준 옆에는 원래 목표 제목을 단다.
 */

type T = Translate<ObjectiveMessageKey>;
type Language = "en" | "ko";

const MergeGlyph = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v3.5a3 3 0 0 0 3 3h7" /><path d="M3 13V9.5" /><path d="M10.5 7l2.5 2.5-2.5 2.5" /></svg>;

const byName = (by: Objective["merged"][number]["by"], t: T): string => by.commodore ? t("objectives.actor.commodore") : by.title ?? t("objectives.merged.byAgent");

function ago(at: number, now: number, language: Language): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(0, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
  return now;
}

/** 받은 목표의 브리핑 아래 — 합쳐 온 목표마다 출처 한 줄. */
export function MergedTrail({ objective, t, language }: { readonly objective: Objective; readonly t: T; readonly language: Language }) {
  const now = useNow();
  if (!objective.merged.length) return null;
  return (
    <div className="objectives-merged-trail">
      {objective.merged.map((entry) => (
        <div key={entry.sourceId} className="objectives-merged-entry">
          <span className="objectives-merged-src"><MergeGlyph /><span>{t("objectives.merged.from", { title: entry.title })}</span></span>
          <span>{byName(entry.by, t)} · {ago(entry.at, now, language)}</span>
        </div>
      ))}
    </div>
  );
}

/** 옮겨 온 기준의 원본 제목 — 기준 id → 합쳐 온 목표의 제목. */
export const criterionSources = (objective: Objective): ReadonlyMap<string, string> => new Map(objective.merged.flatMap((entry) => entry.criteriaIds.map((id) => [id, entry.title] as const)));

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { TheaterContributionContext, TheaterMenuContext } from "@fleet-console/sdk/plugin";

import {
  isRunningObjective,
  isWaitingObjective,
  loadCommodore,
  openCommodoreDrawer,
  setCommodoreAutonomy,
  toggleCommodoreDrawer,
  useCommodore,
  useCommodoreDrawer,
  useCommodoreEnabled,
} from "./commodore-state.js";
import { getT } from "./i18n/index.js";
import { useObjectiveTheater } from "./objectives-state.js";

export const clockTime = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 사이드바 Theater 머리 아래의 사령관 줄. 왼쪽 글리프가 자율 운영 스위치(채운 brass 사각 = 켬, 빈 사각 = 끔)이고,
 * 줄을 누르면 「사령관 기록」 서랍이 열린다. 실험 기능 「자율 운영」이 꺼져 있으면 줄이 없다.
 */
export function CommodoreRow({ theater, language }: TheaterContributionContext) {
  const enabled = useCommodoreEnabled();
  if (!enabled) return null;
  return <CommodoreRowBody theaterId={theater.id} theaterLabel={theater.label} language={language} />;
}

function CommodoreRowBody({ theaterId, theaterLabel, language }: { readonly theaterId: string; readonly theaterLabel: string; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const { view } = useCommodore(theaterId);
  const board = useObjectiveTheater(theaterId);
  const drawer = useCommodoreDrawer();
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadCommodore(theaterId); }, [theaterId]);

  const on = view?.state.autonomy === true;
  const open = drawer?.theaterId === theaterId;
  const run = view?.run;
  const running = board.objectives.filter(isRunningObjective).length;
  const waiting = board.objectives.filter(isWaitingObjective).length;
  const meta: { readonly key: string; readonly text: string; readonly tone?: "on" | "warn" }[] = on
    ? [
      { key: "mode", text: t("objectives.commodore.meta.autonomous"), tone: "on" },
      ...(run?.phase === "turn" ? [{ key: "turn", text: t("objectives.commodore.meta.turn") }] : []),
      ...(run?.phase === "retrying" && run.nextWakeAt ? [{ key: "retry", text: t("objectives.commodore.meta.retrying", { time: clockTime(run.nextWakeAt) }), tone: "warn" as const }] : []),
      ...(run?.phase === "error" ? [{ key: "error", text: t("objectives.commodore.meta.error"), tone: "warn" as const }] : []),
      { key: "running", text: t("objectives.commodore.meta.running", { n: running }) },
      { key: "handled", text: t("objectives.commodore.meta.handled", { n: run?.totals.actions ?? 0 }) },
    ]
    : [
      { key: "mode", text: t("objectives.commodore.meta.manual") },
      { key: "waiting", text: t("objectives.commodore.meta.waiting", { n: waiting }) },
    ];
  const patrol = on && run?.phase === "idle" && run.nextWakeAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null;
  const errorReason = on && (run?.phase === "error" || run?.phase === "retrying") ? run.reason ?? null : null;

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (busy || !view) return;
    setBusy(true);
    void setCommodoreAutonomy(theaterId, !on).catch(() => undefined).finally(() => setBusy(false));
  };
  const switchTitle = [on ? t("objectives.commodore.switchOnTitle") : t("objectives.commodore.switchOffTitle"), errorReason].filter(Boolean).join("\n");

  return (
    <div className={`objectives-commodore-row${open ? " is-open" : ""}${on ? " is-on" : ""}`} data-theater-id={theaterId}>
      <button
        type="button"
        role="switch"
        className="objectives-commodore-switch"
        aria-checked={on}
        aria-label={t("objectives.commodore.switchAria")}
        aria-busy={busy || undefined}
        disabled={!view}
        title={switchTitle}
        onClick={toggle}
      >
        <i aria-hidden="true" />
      </button>
      <button
        type="button"
        className="objectives-commodore-row-main"
        aria-expanded={open}
        aria-label={[t("objectives.commodore.rowAria", { theater: theaterLabel }), ...meta.map((part) => part.text), patrol ?? ""].filter(Boolean).join(", ")}
        title={patrol ?? errorReason ?? undefined}
        onClick={() => toggleCommodoreDrawer(theaterId)}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => { if (event.key === "Escape" && open) { event.preventDefault(); toggleCommodoreDrawer(theaterId); } }}
      >
        <span className="objectives-commodore-row-title">{t("objectives.commodore.name")}</span>
        <span className="objectives-commodore-row-meta" aria-hidden="true">
          {meta.map((part, index) => (
            <span key={part.key} className={part.tone ? `is-${part.tone}` : undefined}>{index > 0 ? "· " : ""}{part.text}</span>
          ))}
        </span>
      </button>
    </div>
  );
}

/** Theater 「…」 메뉴의 「사령관 지시…」 — 서랍을 지시 탭으로 연다. */
export function CommodoreMenuItem({ theater, language, onClose }: TheaterMenuContext) {
  const enabled = useCommodoreEnabled();
  if (!enabled) return null;
  const t = getT(language);
  return (
    <button
      type="button"
      role="menuitem"
      className="theater-menu-item objectives-commodore-menu-item"
      onClick={() => { onClose(); openCommodoreDrawer(theater.id, "directive"); }}
    >
      <span className="theater-menu-check objectives-commodore-menu-glyph" aria-hidden="true"><i /></span>
      <span className="theater-menu-label">{t("objectives.commodore.menu")}</span>
    </button>
  );
}

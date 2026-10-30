import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronGlyph } from "@fleet-console/ui/react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/i18n";

import type { ObjectiveMessageKey } from "./i18n/index.js";

/** 기한 달력. 날짜를 즉시 고르고, 이미 고른 날짜를 다시 고르면 기한을 지운다.
 * trigger를 넘기면 그 단추 누름은 바깥 클릭으로 닫지 않는다 — 단추의 토글이 닫게 해, 다시 누르면 닫혔다 곧바로 다시 열리지 않는다. */
const pad = (value: number) => String(value).padStart(2, "0");
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parse = (value: string | null): Date | null => {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };

export function DatePicker({ anchor, trigger, value, language, t, onPick, onClose }: {
  readonly anchor: DOMRect;
  readonly trigger?: RefObject<Element | null>;
  readonly value: string | null;
  readonly language: "en" | "ko";
  readonly t: Translate<ObjectiveMessageKey>;
  readonly onPick: (value: string | null) => void;
  readonly onClose: () => void;
}) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const selected = parse(value);
  const [cursor, setCursor] = useState<Date>(selected ?? today);
  const [month, setMonth] = useState<Date>(new Date((selected ?? today).getFullYear(), (selected ?? today).getMonth(), 1));
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const locale = language === "ko" ? "ko-KR" : "en-US";

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
    const below = anchor.bottom + 6;
    const top = below + rect.height > window.innerHeight - 8 ? Math.max(8, anchor.top - rect.height - 6) : below;
    setPos({ left, top });
  }, [anchor, month]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger?.current?.contains(target)) return;
      if (cardRef.current && !cardRef.current.contains(target)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose, trigger]);
  useEffect(() => { cardRef.current?.focus(); }, []);
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); onClose();
    };
    document.addEventListener("keydown", onEscape, true);
    return () => document.removeEventListener("keydown", onEscape, true);
  }, [onClose]);

  const move = (days: number) => {
    const next = addDays(cursor, days);
    setCursor(next);
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };
  const pickDay = (key: string) => {
    onPick(key === value ? null : key); onClose();
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-7); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); move(7); return; }
    // 날짜 전용에서도 빠른 칩·월 이동 단추의 Enter 는 그 단추가 받는다 — 달력이 가로채면 커서 날짜(=고른 날짜)를 다시 골라 기한이 지워진다.
    if (event.key === "Enter" && event.target !== event.currentTarget && (event.target as HTMLElement).matches('button:not([role="gridcell"])')) return;
    if (event.key === "Enter") { event.preventDefault(); pickDay(iso(cursor)); }
  };

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const cells = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(addDays(gridStart, index)));
  const monthLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(month);
  const quick: { key: ObjectiveMessageKey; value: string }[] = [
    { key: "objectives.date.today", value: iso(today) },
    { key: "objectives.date.tomorrow", value: iso(addDays(today, 1)) },
    { key: "objectives.date.nextWeek", value: iso(addDays(today, 7)) },
  ];

  return createPortal(
    <div ref={cardRef} className="objectives-cal" role="dialog" aria-label={t("objectives.schedule.due")} tabIndex={-1} style={pos} onKeyDown={onKey}>
      <div className="objectives-cal-quick">
        {quick.map((entry) => <button key={entry.key} type="button" className={`objectives-cal-chip${value === entry.value ? " is-on" : ""}`} onClick={() => { onPick(entry.value === value ? null : entry.value); onClose(); }}>{t(entry.key)}</button>)}
        {value ? <button type="button" className="objectives-cal-chip is-clear" onClick={() => { onPick(null); onClose(); }}>{t("objectives.date.clear")}</button> : null}
      </div>
      <div className="objectives-cal-head">
        <button type="button" className="objectives-glyph" aria-label={t("objectives.date.prevMonth")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronGlyph direction="left" /></button>
        <span className="objectives-cal-month">{monthLabel}</span>
        <button type="button" className="objectives-glyph" aria-label={t("objectives.date.nextMonth")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronGlyph direction="right" /></button>
      </div>
      <div className="objectives-cal-grid" role="grid">
        {weekdays.map((day, index) => <span key={`w${index}`} className="objectives-cal-wd" aria-hidden="true">{day}</span>)}
        {cells.map((day) => {
          const key = iso(day);
          const outside = day.getMonth() !== month.getMonth();
          const isToday = key === iso(today);
          const isSelected = key === value;
          const isCursor = key === iso(cursor);
          return <button key={key} type="button" role="gridcell" aria-selected={isSelected} aria-current={isToday ? "date" : undefined} aria-label={key} tabIndex={-1}
            className={`objectives-cal-day${outside ? " is-outside" : ""}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}${isCursor ? " is-cursor" : ""}${day < today ? " is-past" : ""}`}
            onClick={() => pickDay(key)}>{day.getDate()}</button>;
        })}
      </div>

    </div>, document.body,
  );
}

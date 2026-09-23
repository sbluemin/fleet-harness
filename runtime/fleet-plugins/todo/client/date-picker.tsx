import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { TodoMessageKey } from "./i18n/index.js";

/**
 * 기한 달력 — OS 달력 대신 표면의 문법으로 그린 팝오버. 월 하나, 요일 머리, 오늘은 고리, 고른 날은 brass.
 * 위에는 자주 쓰는 날(오늘·내일·다음 주)과 「없음」. 키보드: ←→ 하루, ↑↓ 한 주, Enter 고르기, Esc 닫기.
 */

const pad = (value: number) => String(value).padStart(2, "0");
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parse = (value: string | null): Date | null => {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };

export function DatePicker({ anchor, value, language, t, onPick, onClose }: {
  readonly anchor: DOMRect;
  readonly value: string | null;
  readonly language: "en" | "ko";
  readonly t: Translate<TodoMessageKey>;
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
  const weekStart = language === "ko" ? 0 : 0;

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
    const onDown = (event: PointerEvent) => { if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  useEffect(() => { cardRef.current?.focus(); }, []);

  const move = (days: number) => {
    const next = addDays(cursor, days);
    setCursor(next);
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-7); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); move(7); return; }
    if (event.key === "Enter") { event.preventDefault(); onPick(iso(cursor)); onClose(); }
  };

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const gridStart = addDays(first, -lead);
  const cells = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(addDays(gridStart, index)));
  const monthLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(month);
  const quick: { key: TodoMessageKey; value: string | null }[] = [
    { key: "todo.date.today", value: iso(today) },
    { key: "todo.date.tomorrow", value: iso(addDays(today, 1)) },
    { key: "todo.date.nextWeek", value: iso(addDays(today, 7)) },
  ];

  return createPortal(
    <div ref={cardRef} className="todo-cal" role="dialog" aria-label={t("todo.schedule.due")} tabIndex={-1} style={pos} onKeyDown={onKey}>
      <div className="todo-cal-quick">
        {quick.map((entry) => <button key={entry.key} type="button" className={`todo-cal-chip${value === entry.value ? " is-on" : ""}`} onClick={() => { onPick(entry.value); onClose(); }}>{t(entry.key)}</button>)}
        {value ? <button type="button" className="todo-cal-chip is-clear" onClick={() => { onPick(null); onClose(); }}>{t("todo.date.clear")}</button> : null}
      </div>
      <div className="todo-cal-head">
        <button type="button" className="todo-glyph" aria-label={t("todo.date.prevMonth")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <span className="todo-cal-month">{monthLabel}</span>
        <button type="button" className="todo-glyph" aria-label={t("todo.date.nextMonth")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="todo-cal-grid" role="grid">
        {weekdays.map((day, index) => <span key={`w${index}`} className="todo-cal-wd" aria-hidden="true">{day}</span>)}
        {cells.map((day) => {
          const key = iso(day);
          const outside = day.getMonth() !== month.getMonth();
          const isToday = key === iso(today);
          const isSelected = key === value;
          const isCursor = key === iso(cursor);
          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              aria-selected={isSelected}
              aria-current={isToday ? "date" : undefined}
              tabIndex={-1}
              className={`todo-cal-day${outside ? " is-outside" : ""}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}${isCursor ? " is-cursor" : ""}${day < today ? " is-past" : ""}`}
              onClick={() => { onPick(key); onClose(); }}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

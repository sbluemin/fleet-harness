import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { ObjectiveMessageKey } from "./i18n/index.js";

/** 기한 달력. withTime에서는 지역 날짜·시각을 함께 고르고 예약으로 확정한다. 날짜 전용 호출은 즉시 고른다. */
const pad = (value: number) => String(value).padStart(2, "0");
const iso = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const localDateTime = (date: Date) => `${iso(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
const parse = (value: string | null): Date | null => {
  if (!value) return null;
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next; };

export function DatePicker({ anchor, value, language, t, onPick, onClose, withTime = false }: {
  readonly anchor: DOMRect;
  readonly value: string | null;
  readonly language: "en" | "ko";
  readonly t: Translate<ObjectiveMessageKey>;
  readonly onPick: (value: string | null) => void;
  readonly onClose: () => void;
  readonly withTime?: boolean;
}) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const selected = parse(value) ?? (withTime ? parse(localDateTime(new Date(Date.now() + 2 * 60 * 60_000))) : null);
  const [cursor, setCursor] = useState<Date>(selected ?? today);
  const [month, setMonth] = useState<Date>(new Date((selected ?? today).getFullYear(), (selected ?? today).getMonth(), 1));
  const [time, setTime] = useState(value?.slice(11, 16) || localDateTime(new Date(Date.now() + 2 * 60 * 60_000)).slice(11));
  const [now, setNow] = useState(Date.now);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const candidate = `${iso(cursor)}T${time}`;
  // 시간대 전환으로 없는 지역 시각도 예약하지 않는다.
  const validTime = /^\d{2}:\d{2}$/.test(time) && Number.isFinite(new Date(candidate).getTime()) && localDateTime(new Date(candidate)) === candidate && new Date(candidate).getTime() > now;

  useEffect(() => {
    if (!withTime) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [withTime]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const left = Math.max(8, Math.min(withTime ? anchor.right - rect.width : anchor.left, window.innerWidth - rect.width - 8));
    const below = anchor.bottom + 6;
    const top = below + rect.height > window.innerHeight - 8 ? Math.max(8, anchor.top - rect.height - 6) : below;
    setPos({ left, top });
  }, [anchor, month, validTime, withTime]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => { if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
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
    if (withTime && next < today) return;
    setCursor(next);
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };
  const pickDay = (key: string) => {
    if (withTime) { const date = parse(key)!; setCursor(date); setMonth(new Date(date.getFullYear(), date.getMonth(), 1)); }
    else { onPick(key); onClose(); }
  };
  const reserve = () => { if (validTime && new Date(candidate).getTime() > Date.now()) { onPick(candidate); onClose(); } };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    // 시각 입력과 달력의 실제 버튼은 자신의 키보드 동작을 쓴다. 날짜 전용 호출의 기존 동작은 그대로다.
    if (withTime && event.target !== event.currentTarget && !(event.target as HTMLElement).matches('[role="gridcell"]')) return;
    if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-7); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); move(7); return; }
    if (event.key === "Enter") { event.preventDefault(); if (withTime) cardRef.current?.querySelector<HTMLInputElement>('input')?.focus(); else pickDay(iso(cursor)); }
  };

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const cells = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
  const weekdays = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(addDays(gridStart, index)));
  const monthLabel = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(month);
  const evening = new Date(today); evening.setHours(18);
  const tomorrow = addDays(today, 1); tomorrow.setHours(9);
  const quick: { key: ObjectiveMessageKey; value: string }[] = withTime ? [
    { key: "objectives.date.inTwoHours", value: localDateTime(new Date(now + 2 * 60 * 60_000)) },
    { key: "objectives.date.todayEvening", value: localDateTime(evening) },
    { key: "objectives.date.tomorrowMorning", value: localDateTime(tomorrow) },
  ] : [
    { key: "objectives.date.today", value: iso(today) },
    { key: "objectives.date.tomorrow", value: iso(addDays(today, 1)) },
    { key: "objectives.date.nextWeek", value: iso(addDays(today, 7)) },
  ];

  return createPortal(
    <div ref={cardRef} className={`objectives-cal${withTime ? " is-time" : ""}`} role="dialog" aria-label={t(withTime ? "objectives.commodore.stop.title" : "objectives.schedule.due")} tabIndex={-1} style={pos} onKeyDown={onKey}>
      <div className="objectives-cal-quick">
        {quick.map((entry) => <button key={entry.key} type="button" disabled={withTime && new Date(entry.value).getTime() <= now} className={`objectives-cal-chip${value === entry.value ? " is-on" : ""}`} onClick={() => { onPick(entry.value); onClose(); }}>{t(entry.key)}</button>)}
        {value ? <button type="button" className="objectives-cal-chip is-clear" onClick={() => { onPick(null); onClose(); }}>{t(withTime ? "objectives.commodore.stop.cancel" : "objectives.date.clear")}</button> : null}
      </div>
      <div className="objectives-cal-head">
        <button type="button" className="objectives-glyph" aria-label={t("objectives.date.prevMonth")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
        <span className="objectives-cal-month">{monthLabel}</span>
        <button type="button" className="objectives-glyph" aria-label={t("objectives.date.nextMonth")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
      </div>
      <div className="objectives-cal-grid" role="grid">
        {weekdays.map((day, index) => <span key={`w${index}`} className="objectives-cal-wd" aria-hidden="true">{day}</span>)}
        {cells.map((day) => {
          const key = iso(day);
          const outside = day.getMonth() !== month.getMonth();
          const isToday = key === iso(today);
          const isSelected = key === (withTime ? iso(cursor) : value);
          const isCursor = key === iso(cursor);
          return <button key={key} type="button" role="gridcell" aria-selected={isSelected} aria-current={isToday ? "date" : undefined} aria-label={key} tabIndex={-1} disabled={withTime && day < today}
            className={`objectives-cal-day${outside ? " is-outside" : ""}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}${isCursor ? " is-cursor" : ""}${day < today ? " is-past" : ""}`}
            onClick={() => pickDay(key)}>{day.getDate()}</button>;
        })}
      </div>
      {withTime ? <>
        <div className="objectives-cal-time">
          <label>{t("objectives.date.time")} <input type="time" aria-label={t("objectives.date.time")} value={time} onChange={(event) => setTime(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); reserve(); } }} /></label>
          <button type="button" className="objectives-primary" disabled={!validTime} onClick={reserve}>{t("objectives.date.reserve")}</button>
        </div>
        {!validTime ? <p className="objectives-cal-error" role="status">{t("objectives.date.futureOnly")}</p> : null}
      </> : null}
    </div>, document.body,
  );
}

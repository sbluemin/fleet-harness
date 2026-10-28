import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { CommodoreRoutine } from "../shared/contracts/types.js";
import { removeCommodoreRoutine, toggleCommodoreRoutine, useCommodore, useCommodoreOnline } from "./commodore-state.js";
import { getT } from "./i18n/index.js";
import "./commodore-routines.css";

type T = ReturnType<typeof getT>;
const localeOf = (language: "en" | "ko") => language === "ko" ? "ko-KR" : "en-US";

function scheduleWord(routine: CommodoreRoutine, language: "en" | "ko", t: T, timeZone?: string): string {
  const { schedule } = routine;
  const locale = localeOf(language);
  if (schedule.kind === "every") return t(schedule.minutes % 60 === 0 ? "commodore.routines.hours" : "commodore.routines.minutes", { n: schedule.minutes % 60 === 0 ? schedule.minutes / 60 : schedule.minutes });
  if (schedule.kind === "once") return t("commodore.routines.around", { time: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(schedule.at) });
  const [hour, minute] = schedule.time.split(":").map(Number);
  const date = new Date(2024, 0, 7, hour, minute);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date);
  const days = [...schedule.days].sort((a, b) => a - b);
  const label = days.length === 7 ? t("commodore.routines.daily") : days.join() === "1,2,3,4,5" ? t("commodore.routines.weekdays") : days.map((day) => new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 7 + day))).join(" · ");
  return t("commodore.routines.dailyAt", { days: label, time });
}

/** 메뉴와 길게 누르기는 이 feature 내부에서 소유한다. 다른 feature의 비공개 UI 구현은 가져오지 않는다. */
export function CommodoreRoutines({ commodoreId, language, phone = false, onRequest }: { readonly commodoreId: string; readonly language: "en" | "ko"; readonly phone?: boolean; readonly onRequest: () => void }) {
  const t = getT(language);
  const { view } = useCommodore(commodoreId);
  const online = useCommodoreOnline();
  const routines = view?.state.routines ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const selected = routines.find((routine) => routine.id === menu?.id);
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  const close = () => { menu?.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); };
  const open = (routine: CommodoreRoutine, trigger: HTMLElement, x: number, y: number) => { cancelPress(); setArmed(false); setMenu({ id: routine.id, trigger, x, y }); };
  useEffect(() => () => cancelPress(), []);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) { menu.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false); } };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); menu.trigger.focus({ preventScroll: true }); setMenu(null); setArmed(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("keydown", escape, true); };
  }, [menu]);
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node || !menu) return;
    if (!phone) {
      const rect = node.getBoundingClientRect();
      node.style.left = `${Math.max(16, Math.min(menu.x, window.innerWidth - rect.width - 16))}px`;
      node.style.top = `${Math.max(16, Math.min(menu.y, window.innerHeight - rect.height - 16))}px`;
    }
    node.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu, phone]);
  const act = async (work: () => Promise<void>, message: string) => {
    if (busy || !online) return;
    setBusy(true); setFailure("");
    try { await work(); setNotice(message); close(); }
    catch (error) { setFailure(t("commodore.failed", { code: error instanceof Error ? error.message : "failed" })); }
    finally { setBusy(false); }
  };
  const toggle = (routine: CommodoreRoutine) => void act(() => toggleCommodoreRoutine(commodoreId, routine.id, !routine.enabled), t(routine.enabled ? "commodore.routines.paused" : "commodore.routines.enabled"));
  const onMenuKey = (event: KeyboardEvent) => {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1);
      buttons[(next + buttons.length) % buttons.length]?.focus();
    }
  };
  return <div className={`commodore-routines${phone ? " is-phone" : ""}`}>
    <p className="commodore-routines-hint">{t(phone ? "commodore.routines.phoneHint" : "commodore.routines.hint")}</p>
    {!view ? <p>{t("commodore.board.launch.loading")}</p> : !routines.length ? <div className="commodore-routines-empty">
      <p>{t("commodore.routines.empty")}</p><p>{t("commodore.routines.example")}</p>
      <button type="button" className="fc-btn fc-btn--secondary" onClick={onRequest}>{t("commodore.routines.request")}</button>
    </div> : <>
      <p className="commodore-routines-hint">{t("commodore.routines.count", { n: routines.filter((r) => r.enabled).length, total: routines.length })}</p>
      <div className="commodore-routines-list">{routines.map((routine) => <div key={routine.id} className={`commodore-routines-row${routine.enabled ? "" : " is-off"}`} tabIndex={-1}
        onContextMenu={(event) => { event.preventDefault(); open(routine, event.currentTarget, event.clientX, event.clientY); }}
        onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); open(routine, event.currentTarget, rect.left + 16, rect.bottom); } }}
        onPointerDown={(event) => {
          if (!phone || event.button !== 0 || (event.target as HTMLElement).closest('[role="switch"]')) return;
          cancelPress(); suppressClick.current = false;
          const trigger = event.currentTarget; const { clientX: x, clientY: y } = event;
          press.current = { x, y, timer: setTimeout(() => { suppressClick.current = true; open(routine, trigger, x, y); }, 500) };
        }}
        onPointerMove={(event) => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 6) cancelPress(); }}
        onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}
        onClickCapture={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}>
        <button type="button" className="commodore-routines-main" aria-expanded={expanded === routine.id} aria-haspopup={phone ? "dialog" : "menu"} onClick={() => setExpanded(expanded === routine.id ? null : routine.id)}>
          <span className="commodore-routines-name">{routine.name}</span><span className="commodore-routines-when">{scheduleWord(routine, language, t, view?.run.routineTimeZone)}</span>
        </button>
        <button type="button" role="switch" aria-checked={routine.enabled} aria-label={`${routine.name} · ${t(routine.enabled ? "commodore.routines.turnOff" : "commodore.routines.turnOn")}`} disabled={!online || busy} className="commodore-routines-switch" onClick={() => toggle(routine)} />
        {expanded === routine.id ? <dl className="commodore-routines-detail"><dt>{t("commodore.routines.task")}</dt><dd>{routine.task}</dd><dt>{t("commodore.routines.next")}</dt><dd>{routine.enabled ? (view?.run.routineNextRuns?.[routine.id] ? new Intl.DateTimeFormat(localeOf(language), { dateStyle: "medium", timeStyle: "short", timeZone: view.run.routineTimeZone }).format(view.run.routineNextRuns[routine.id]!) : "—") : t("commodore.routines.off")}</dd><dt>{t("commodore.routines.last")}</dt><dd>{routine.lastRunAt ? new Intl.DateTimeFormat(localeOf(language), { dateStyle: "medium", timeStyle: "short", timeZone: view?.run.routineTimeZone }).format(routine.lastRunAt) : "—"}</dd></dl> : null}
      </div>)}</div>
    </>}
    {notice ? <p role="status" className="commodore-routines-hint">{notice}</p> : null}
    {failure ? <p role="alert" className="commodore-routines-error">{failure}</p> : null}
    {menu && selected ? createPortal(<div className={phone ? "commodore-routines-scrim" : "commodore-routines-menu-host"}>
      <div ref={menuRef} className={`commodore-routines-menu${phone ? " is-sheet" : ""}`} role={phone ? "dialog" : "menu"} aria-modal={phone ? true : undefined} aria-label={selected.name} onKeyDown={onMenuKey}>
        <div className="commodore-routines-menu-title">{selected.name}</div>
        <button type="button" role={phone ? undefined : "menuitem"} disabled={!online || busy} onClick={() => toggle(selected)}>{t(selected.enabled ? "commodore.routines.turnOff" : "commodore.routines.turnOn")}</button>
        <div className="commodore-routines-separator" role="separator" />
        <button type="button" role={phone ? undefined : "menuitem"} className={`is-danger${armed ? " is-armed" : ""}`} disabled={!online || busy} onClick={() => {
          if (!armed) { setArmed(true); return; }
          void act(() => removeCommodoreRoutine(commodoreId, selected.id), t("commodore.routines.removed"));
        }}>{t(armed ? "commodore.routines.confirmRemove" : "commodore.routines.remove")}</button>
      </div>
    </div>, document.body) : null}
  </div>;
}

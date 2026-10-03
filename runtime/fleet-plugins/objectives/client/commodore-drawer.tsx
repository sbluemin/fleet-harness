import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { Translate } from "@fleet-console/sdk/i18n";
import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { EXPERIMENT_EFFORTS } from "@fleet-console/sdk/settings/browser";

import type { CommodoreTranscriptEntry } from "../server/commodore/types.js";
import { clockTime } from "./commodore-row.js";
import {
  addCommodoreIntel,
  closeCommodoreDrawer,
  commodoreTheaterLabel,
  loadTranscript,
  messageCommodore,
  removeCommodoreIntel,
  retryCommodore,
  saveCommodoreDirective,
  setCommodoreAutonomy,
  setCommodoreCoordinates,
  setCommodoreTab,
  useCommodore,
  useCommodoreDrawer,
  useCommodoreEnabled,
  type CommodoreTab,
} from "./commodore-state.js";
import { getT, objectivesEn, type ObjectiveMessageKey } from "./i18n/index.js";
import { LaunchControl } from "./launch-control.js";

type T = Translate<ObjectiveMessageKey>;

const DRAWER_WIDTH = 440;
const DRAWER_GAP = 8;
const DRAWER_MARGIN = 8;
/** 보드 읽기는 행위가 아니다 — 기록의 행위 칩에는 보드를 바꾼 호출만 선다. */
const READ_ACTIONS = new Set(["view", "read", "list", "get", "inbox", "fleet", "history", "evidence"]);

/** 상주 기여 — 서랍은 사령관 줄이 접혀 사라져도 열린 채로 남는다. */
export function CommodoreDrawerHost({ language }: PersistentComponentContext) {
  const enabled = useCommodoreEnabled();
  const drawer = useCommodoreDrawer();
  if (!enabled || !drawer) return null;
  return <CommodoreDrawer key={drawer.theaterId} theaterId={drawer.theaterId} tab={drawer.tab} openedAt={drawer.openedAt} language={language ?? "en"} />;
}

function rowElement(theaterId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.objectives-commodore-row[data-theater-id="${CSS.escape(theaterId)}"]`);
}

/** 사이드바 바로 옆 — 사령관 줄이 선 목록의 오른쪽 가장자리에 붙고, 높이는 목록과 같다. */
function useDrawerPosition(theaterId: string): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ left: 300, top: 48, height: "calc(100vh - 96px)" });
  useLayoutEffect(() => {
    const place = () => {
      const row = rowElement(theaterId);
      const list = row?.closest("aside")?.getBoundingClientRect() ?? row?.getBoundingClientRect() ?? null;
      const left = Math.max(DRAWER_MARGIN, Math.min(window.innerWidth - DRAWER_WIDTH - DRAWER_MARGIN, (list?.right ?? 292) + DRAWER_GAP));
      const top = Math.max(DRAWER_MARGIN, list?.top ?? 48);
      const bottom = Math.min(window.innerHeight - DRAWER_MARGIN, list && list.bottom > top + 200 ? list.bottom : window.innerHeight - DRAWER_MARGIN);
      // 높이는 목록과 같게 고정한다 — 탭을 바꿀 때마다 서랍이 늘고 줄지 않게.
      setPosition({ left, top, height: Math.max(240, bottom - top) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [theaterId]);
  return position;
}

function CommodoreDrawer({ theaterId, tab, openedAt, language }: { readonly theaterId: string; readonly tab: CommodoreTab; readonly openedAt: number; readonly language: "en" | "ko" }) {
  const t = getT(language);
  const { view, entries, hasMore, transcriptLoaded } = useCommodore(theaterId);
  const position = useDrawerPosition(theaterId);
  const dialogRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Record<CommodoreTab, HTMLButtonElement | null>>({ log: null, directive: null, intel: null });
  const [failure, setFailure] = useState<string | null>(null);
  const label = commodoreTheaterLabel(theaterId);
  const on = view?.state.autonomy === true;
  const run = view?.run;

  // 열릴 때 — 지시 탭으로 열었으면 입력란에, 아니면 서랍에 초점을 둔다. 사령관 줄에서 열었으면 줄에 남겨도 되지만,
  // 키보드 사용자가 서랍에 닿을 길은 탭 하나다. 초점은 열 때 한 번만 옮긴다.
  useEffect(() => {
    const target = dialogRef.current?.querySelector<HTMLElement>(tab === "log" ? "[role='tab'][aria-selected='true']" : "textarea");
    target?.focus({ preventScroll: true });
  }, [openedAt]); // eslint-disable-line react-hooks/exhaustive-deps -- 여는 순간만.

  const close = () => {
    closeCommodoreDrawer();
    rowElement(theaterId)?.querySelector<HTMLElement>(".objectives-commodore-row-main")?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const fail = (error: unknown) => {
    const code = error instanceof Error ? error.message : "failed";
    setFailure(code === "commodore_disabled" ? t("objectives.commodore.failed.disabled") : t("objectives.commodore.failed", { code }));
  };
  const tabs: readonly { readonly id: CommodoreTab; readonly label: string }[] = [
    { id: "log", label: t("objectives.commodore.tabs.log") },
    { id: "directive", label: t("objectives.commodore.tabs.directive") },
    { id: "intel", label: t("objectives.commodore.tabs.intel") },
  ];
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    const id = tabs[next]!.id;
    setCommodoreTab(id);
    tabRefs.current[id]?.focus();
  };

  const status = !view ? "" : [
    on ? t("objectives.commodore.meta.autonomous") : t("objectives.commodore.meta.manual"),
    on && run?.phase === "idle" && run.nextWakeAt ? t("objectives.commodore.drawer.nextPatrol", { time: clockTime(run.nextWakeAt) }) : null,
    on && run?.phase === "turn" ? t("objectives.commodore.meta.turn") : null,
    on && run?.phase === "retrying" && run.nextWakeAt ? t("objectives.commodore.drawer.retryAt", { time: clockTime(run.nextWakeAt) }) : null,
    on && run?.phase === "error" ? `${t("objectives.commodore.meta.error")}${run.reason ? ` · ${errorWord(t, run.reason)}` : ""}` : null,
    run && run.totals.session > 0 ? t("objectives.commodore.drawer.session", { n: run.totals.session }) : null,
    t("objectives.commodore.drawer.cost", { cost: (run?.totals.costUsd ?? 0).toFixed(2) }),
  ].filter(Boolean).join(" · ");

  const model = view?.state.model ?? view?.defaults.model;
  const effort = view?.state.effort ?? view?.defaults.effort;
  const overridden = view?.state.model !== undefined;

  return createPortal(
    <section
      ref={dialogRef}
      className="objectives-commodore-drawer"
      role="dialog"
      aria-label={t("objectives.commodore.drawer.aria", { theater: label })}
      style={position}
      onKeyDown={onKeyDown}
    >
      <header className="objectives-commodore-drawer-head">
        <button
          type="button"
          role="switch"
          className="objectives-commodore-switch is-large"
          aria-checked={on}
          aria-label={t("objectives.commodore.switchAria")}
          title={on ? t("objectives.commodore.switchOnTitle") : t("objectives.commodore.switchOffTitle")}
          disabled={!view}
          onClick={() => { setFailure(null); void setCommodoreAutonomy(theaterId, !on).catch(fail); }}
        >
          <i aria-hidden="true" />
        </button>
        <div className="objectives-commodore-drawer-id">
          <p className="objectives-commodore-drawer-name">{label ? t("objectives.commodore.drawer.title", { theater: label }) : t("objectives.commodore.name")}</p>
          <p className="objectives-commodore-drawer-sub">{status}</p>
        </div>
        {view && model ? (
          <LaunchControl
            t={t}
            model={model}
            effort={effort}
            locked={false}
            efforts={EXPERIMENT_EFFORTS}
            commitOnClose
            startAtList
            triggerLabel={t("objectives.commodore.drawer.modelAria")}
            head={<span className="objectives-commodore-model-head">{t("objectives.commodore.drawer.modelHead")}</span>}
            extras={[{ id: "defaults", label: t("objectives.commodore.drawer.useDefaults"), active: !overridden, onPick: () => { void setCommodoreCoordinates(theaterId, null).catch(fail); } }]}
            onChange={(next) => {
              const nextModel = next.model ?? model;
              // 트랙의 「자동」은 사령관에게 실험 기능 행의 강도다 — 저장소는 정해진 사다리만 받는다.
              const nextEffort = next.effort && (EXPERIMENT_EFFORTS as readonly string[]).includes(next.effort) ? next.effort : view.defaults.effort;
              setFailure(null);
              void setCommodoreCoordinates(theaterId, { model: nextModel, effort: nextEffort }).catch(fail);
            }}
          />
        ) : null}
        <button type="button" className="objectives-commodore-close" aria-label={t("objectives.commodore.drawer.close")} title={t("objectives.commodore.drawer.close")} onClick={close}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </header>
      {on && (run?.phase === "retrying" || run?.phase === "error") ? (
        <div className="objectives-commodore-retry">
          <span>{run.reason ? errorWord(t, run.reason) : t("objectives.commodore.meta.error")}</span>
          <button type="button" className="objectives-commodore-text-button" onClick={() => { setFailure(null); void retryCommodore(theaterId).catch(fail); }}>{t("objectives.commodore.drawer.retryNow")}</button>
        </div>
      ) : null}
      <div className="objectives-commodore-tabs" role="tablist" aria-label={t("objectives.commodore.tabs.aria")}>
        {tabs.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => { tabRefs.current[item.id] = node; }}
            type="button"
            role="tab"
            id={`objectives-commodore-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`objectives-commodore-panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            className="objectives-commodore-tab"
            onClick={() => setCommodoreTab(item.id)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="objectives-commodore-body" role="tabpanel" id={`objectives-commodore-panel-${tab}`} aria-labelledby={`objectives-commodore-tab-${tab}`}>
        {tab === "log" ? <CommodoreLog t={t} theaterId={theaterId} entries={entries} hasMore={hasMore} loaded={transcriptLoaded} /> : null}
        {tab === "directive" && view ? <CommodoreDirective t={t} theaterId={theaterId} directive={view.state.directive} active={view.active} onFail={fail} /> : null}
        {tab === "intel" && view ? <CommodoreIntel t={t} theaterId={theaterId} intel={view.state.intel} sources={view.state.sources} onFail={fail} /> : null}
      </div>
      {failure ? <p className="objectives-commodore-failure" role="alert">{failure}</p> : null}
      <footer className="objectives-commodore-foot">
        {tab === "log" ? <CommodoreComposer t={t} theaterId={theaterId} onFail={fail} /> : <span className="objectives-commodore-foot-note">{t("objectives.commodore.composer.elsewhere")}</span>}
      </footer>
    </section>,
    document.body,
  );
}

function errorWord(t: T, code: string): string {
  const key = `objectives.commodore.errorCode.${code}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : code;
}

/** 깨움 이유 — `code` 또는 `code:N` 토큰. 모르는 토큰(문장)은 그대로 보인다. */
function reasonWord(t: T, reason: string): string {
  const match = /^([a-z][a-z-]*)(?::(\d+))?$/.exec(reason);
  if (!match) return reason;
  const key = `objectives.commodore.reason.${match[1]}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey, { n: match[2] ?? "" }).trim() : reason;
}

function actionWord(t: T, action: string): string {
  const key = `objectives.commodore.action.${action}`;
  return key in objectivesEn ? t(key as ObjectiveMessageKey) : action;
}

/* ── 기록 ─────────────────────────────────────────────────────────────── */

type ToolEntry = Extract<CommodoreTranscriptEntry, { kind: "tool" }>;

interface WakeGroup {
  readonly kind: "wake";
  readonly key: string;
  readonly at: number;
  reasons: readonly string[];
  readonly texts: string[];
  readonly actions: { readonly key: string; readonly action: string; readonly title: string }[];
  readonly tools: ToolEntry[];
  readonly notes: { readonly key: string; readonly text: string; readonly tone: "warn" | "dim" }[];
}

type LogItem =
  | WakeGroup
  | { readonly kind: "marker"; readonly key: string; readonly at: number; readonly text: string }
  | { readonly kind: "message"; readonly key: string; readonly at: number; readonly text: string };

/** 서버는 사건마다 한 줄을 쌓는다 — 깨움에서 결과까지를 한 묶음으로 모으고, 세션 구분선과 사람의 말은 따로 선다. */
export function groupTranscript(t: T, entries: readonly CommodoreTranscriptEntry[]): LogItem[] {
  const items: LogItem[] = [];
  let open: WakeGroup | null = null;
  const start = (entry: CommodoreTranscriptEntry, reasons: readonly string[]): WakeGroup => {
    const group: WakeGroup = { kind: "wake", key: `w${entry.seq}`, at: entry.at, reasons, texts: [], actions: [], tools: [], notes: [] };
    items.push(group);
    return group;
  };
  for (const entry of entries) {
    switch (entry.kind) {
      case "wake":
        open = start(entry, entry.reasons);
        break;
      case "session":
        open = null;
        items.push({ kind: "marker", key: `s${entry.seq}`, at: entry.at, text: t(`objectives.commodore.log.session.${entry.event}`) });
        break;
      case "message":
        items.push({ kind: "message", key: `m${entry.seq}`, at: entry.at, text: entry.text });
        break;
      case "text": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        if (entry.text.trim()) group.texts.push(entry.text);
        break;
      }
      case "thinking":
        break;
      case "tool": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        const tool: ToolEntry = entry;
        group.tools.push(tool);
        if (tool.name === "console_objectives" && tool.action && !READ_ACTIONS.has(tool.action)) {
          group.actions.push({ key: `a${entry.seq}`, action: tool.action, title: tool.title ?? "" });
        }
        break;
      }
      case "result": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        if (entry.outcome === "cancelled") group.notes.push({ key: `r${entry.seq}`, text: t("objectives.commodore.log.cancelled"), tone: "dim" });
        if (entry.outcome === "error" && !group.notes.some((note) => note.tone === "warn")) group.notes.push({ key: `r${entry.seq}`, text: t("objectives.commodore.log.turnError", { reason: entry.error ? errorWord(t, entry.error) : t("objectives.commodore.meta.error") }), tone: "warn" });
        open = null;
        break;
      }
      case "error": {
        const group: WakeGroup = open ?? (open = start(entry, []));
        const code = errorWord(t, entry.code);
        group.notes.push({ key: `e${entry.seq}`, text: entry.retryAt ? t("objectives.commodore.log.errorRetry", { code, time: clockTime(entry.retryAt) }) : t("objectives.commodore.log.error", { code }), tone: "warn" });
        break;
      }
    }
  }
  return items;
}

function toolSummary(tools: readonly ToolEntry[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} × ${count}`).join(" · ");
}

function CommodoreLog({ t, theaterId, entries, hasMore, loaded }: { readonly t: T; readonly theaterId: string; readonly entries: readonly CommodoreTranscriptEntry[]; readonly hasMore: boolean; readonly loaded: boolean }) {
  // 새 묶음이 위에 선다 — 서랍을 열면 방금 일어난 일이 먼저 보인다.
  const items = useMemo(() => groupTranscript(t, entries).reverse(), [t, entries]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  if (loaded && items.length === 0) return <p className="objectives-commodore-empty">{t("objectives.commodore.log.empty")}</p>;
  return (
    <div className="objectives-commodore-log">
      {items.map((item) => {
        if (item.kind === "marker") {
          return <p key={item.key} className="objectives-commodore-marker"><span>{clockTime(item.at)}</span><span>{item.text}</span></p>;
        }
        if (item.kind === "message") {
          return (
            <div key={item.key} className="objectives-commodore-wake is-message">
              <p className="objectives-commodore-wake-head"><span>{clockTime(item.at)}</span><b>{t("objectives.commodore.log.you")}</b></p>
              <p className="objectives-commodore-wake-text">{item.text}</p>
            </div>
          );
        }
        return (
          <div key={item.key} className="objectives-commodore-wake">
            <p className="objectives-commodore-wake-head"><span>{clockTime(item.at)}</span><b>{item.reasons.length > 0 ? item.reasons.map((reason) => reasonWord(t, reason)).join(" · ") : t("objectives.commodore.log.woke")}</b></p>
            {item.texts.map((text, index) => <p key={index} className="objectives-commodore-wake-text">{text}</p>)}
            {item.actions.length > 0 ? (
              <div className="objectives-commodore-acts">
                {item.actions.map((act) => <span key={act.key} className="objectives-commodore-act"><b>{actionWord(t, act.action)}</b>{act.title ? <span>{act.title}</span> : null}</span>)}
              </div>
            ) : null}
            {item.notes.map((note) => <p key={note.key} className={`objectives-commodore-note is-${note.tone}`}>{note.text}</p>)}
            {item.tools.length > 0 ? (
              <details className="objectives-commodore-tools">
                <summary>{t("objectives.commodore.log.tools", { summary: toolSummary(item.tools) })}</summary>
                <ul>
                  {item.tools.map((tool) => (
                    <li key={tool.seq} className={tool.ok === false ? "is-failed" : undefined}>
                      <span className="objectives-commodore-tool-name">{tool.action ? `${tool.name} ${tool.action}` : tool.name}</span>
                      {tool.summary ? <span>{tool.summary}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
      {hasMore ? (
        <button type="button" className="objectives-commodore-text-button objectives-commodore-older" disabled={loadingOlder} onClick={() => { setLoadingOlder(true); void loadTranscript(theaterId, { older: true }).finally(() => setLoadingOlder(false)); }}>
          {t("objectives.commodore.log.older")}
        </button>
      ) : null}
    </div>
  );
}

function CommodoreComposer({ t, theaterId, onFail }: { readonly t: T; readonly theaterId: string; readonly onFail: (error: unknown) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const composing = useRef(false);
  const send = () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    void messageCommodore(theaterId, value).then(() => setText("")).catch(onFail).finally(() => setSending(false));
  };
  return (
    <>
      <textarea
        className="objectives-commodore-input"
        value={text}
        rows={1}
        placeholder={t("objectives.commodore.composer.placeholder")}
        aria-label={t("objectives.commodore.composer.aria")}
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }}
      />
      <button type="button" className="objectives-btn" disabled={sending || !text.trim()} onClick={send}>{t("objectives.commodore.composer.send")}</button>
    </>
  );
}

/* ── 지시 ─────────────────────────────────────────────────────────────── */

function CommodoreDirective({ t, theaterId, directive, active, onFail }: { readonly t: T; readonly theaterId: string; readonly directive: { readonly text: string; readonly rev: number; readonly updatedAt: number }; readonly active: boolean; readonly onFail: (error: unknown) => void }) {
  const [draft, setDraft] = useState(directive.text);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // 다른 곳(다른 창)에서 고친 지시는 입력이 깨끗할 때만 따라간다 — 쓰던 글을 덮지 않는다.
  const base = useRef(directive.text);
  useEffect(() => {
    if (draft === base.current) setDraft(directive.text);
    base.current = directive.text;
  }, [directive.text]); // eslint-disable-line react-hooks/exhaustive-deps -- 서버 값이 바뀔 때만.
  const dirty = draft !== directive.text;
  const save = () => {
    if (saving || !dirty) return;
    setSaving(true);
    setSaved(false);
    void saveCommodoreDirective(theaterId, draft).then(() => setSaved(true)).catch(onFail).finally(() => setSaving(false));
  };
  return (
    <div className="objectives-commodore-section">
      <label className="objectives-commodore-section-title" htmlFor="objectives-commodore-directive">{t("objectives.commodore.directive.label")}</label>
      <textarea
        id="objectives-commodore-directive"
        className="objectives-commodore-input is-tall"
        value={draft}
        maxLength={8_000}
        placeholder={t("objectives.commodore.directive.placeholder")}
        onChange={(event) => { setDraft(event.target.value); setSaved(false); }}
      />
      <p className="objectives-commodore-hint">{t("objectives.commodore.directive.hint")}</p>
      <div className="objectives-commodore-section-foot">
        {directive.rev > 0 ? <span className="objectives-commodore-hint">{t("objectives.commodore.directive.rev", { rev: directive.rev, time: clockTime(directive.updatedAt) })}</span> : <span />}
        <button type="button" className="objectives-btn" disabled={saving || !dirty} onClick={save}>{t("objectives.commodore.directive.save")}</button>
      </div>
      {saved && !dirty ? <p className="objectives-commodore-hint is-done" role="status">{t(active ? "objectives.commodore.directive.saved" : "objectives.commodore.directive.savedIdle")}</p> : null}
    </div>
  );
}

/* ── 정보 ─────────────────────────────────────────────────────────────── */

function CommodoreIntel({ t, theaterId, intel, sources, onFail }: {
  readonly t: T;
  readonly theaterId: string;
  readonly intel: readonly { readonly id: string; readonly at: number; readonly source: string; readonly text: string }[];
  readonly sources: readonly { readonly id: string; readonly kind: string; readonly label: string; readonly locator: string }[];
  readonly onFail: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const sourceLabel = (source: string) => source === "person" ? t("objectives.commodore.intel.fromYou") : sources.find((candidate) => candidate.id === source)?.label ?? source;
  const add = () => {
    const value = draft.trim();
    if (!value || adding) return;
    setAdding(true);
    void addCommodoreIntel(theaterId, value).then(() => setDraft("")).catch(onFail).finally(() => setAdding(false));
  };
  const day = (at: number) => { const date = new Date(at); return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  return (
    <>
      <div className="objectives-commodore-section">
        <label className="objectives-commodore-section-title" htmlFor="objectives-commodore-intel">{t("objectives.commodore.intel.label")}</label>
        <textarea
          id="objectives-commodore-intel"
          className="objectives-commodore-input is-medium"
          value={draft}
          maxLength={4_000}
          placeholder={t("objectives.commodore.intel.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="objectives-commodore-section-foot">
          <span />
          <button type="button" className="objectives-btn" disabled={adding || !draft.trim()} onClick={add}>{t("objectives.commodore.intel.add")}</button>
        </div>
        {intel.length === 0 ? <p className="objectives-commodore-hint">{t("objectives.commodore.intel.empty")}</p> : (
          <ul className="objectives-commodore-intel-list">
            {intel.map((item) => (
              <li key={item.id}>
                <span className="objectives-commodore-intel-when">{day(item.at)}</span>
                <span className="objectives-commodore-intel-text">{item.text}<span className="objectives-commodore-intel-source">{sourceLabel(item.source)}</span></span>
                <button type="button" className="objectives-commodore-text-button" aria-label={t("objectives.commodore.intel.removeAria")} onClick={() => { void removeCommodoreIntel(theaterId, item.id).catch(onFail); }}>{t("objectives.commodore.intel.remove")}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="objectives-commodore-section">
        <p className="objectives-commodore-section-title">{t("objectives.commodore.intel.sources")} <span className="objectives-commodore-later">· {t("objectives.commodore.intel.sourcesLater")}</span></p>
        {sources.length === 0 ? <p className="objectives-commodore-hint">{t("objectives.commodore.intel.sourcesEmpty")}</p> : (
          <ul className="objectives-commodore-sources">
            {sources.map((source) => <li key={source.id}><span>{source.label}</span><span className="objectives-commodore-source-locator">{source.locator}</span></li>)}
          </ul>
        )}
        <p className="objectives-commodore-hint">{t("objectives.commodore.intel.sourcesHint")}</p>
      </div>
    </>
  );
}

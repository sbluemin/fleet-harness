import * as React from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../../core/client/src/i18n/index.js";
import type { ContextRailMeasure, ContextRailRow, ContextRailScope, ContextRailSession } from "../../../shared/context-rail.js";
import { useContextRailProviders } from "./registry.js";
import {
  isContextCardOpen, setContextFlyout, setContextRailEnabled, toggleContextCard, toggleContextDetail, useContextRailState,
  type ContextRailState,
} from "./store.js";
import "./context-rail.css";

/** 채팅 폭(대화 칸 전체)이 이 값 이상이면 카드 열, 이 값 미만이면 원호 칩 띠, 그보다 더 좁으면 머리 칩이다. */
const DOCK_MIN = 980;
const STRIP_MIN = 620;
/** 머리 칩은 세션이 이만큼을 넘으면 앞의 둘과 `+n`으로 줄인다. */
const HEAD_CHIPS = 3;

type Tier = "dock" | "strip" | "head";
export type Translate = ReturnType<typeof useT>;

/**
 * 대화 칸 본문과 그 옆의 컨텍스트 레일을 한 줄에 놓는다. 단계는 창 폭이 아니라 이 칸의 실제 폭으로 정한다 — 오른쪽 패널이 열려 있든
 * 닫혀 있든 남은 채팅 폭이 곧 기준이다. 레일은 오른쪽 패널을 열거나 닫지 않는다.
 *
 * `slot`은 대화 머리 오른쪽 끝의 자리다: ▥ 단추와(머리 칩 단계에서) 원호 칩이 거기에 선다.
 */
export function ContextRailHost({ scope, slot, children }: {
  readonly scope: ContextRailScope;
  readonly slot: HTMLElement | null;
  readonly children: React.ReactNode;
}) {
  const providers = useContextRailProviders();
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    // rAF 로 미루지 않는다 — 가려진 탭에서는 rAF 가 멈춰 단계가 낡은 폭에 묶인다. 이 상자의 크기는 단계에 영향을 받지 않아 되먹임이 없다.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={mainRef} className="conversation-main">
      {children}
      {providers.map((Provider, index) => (
        <Provider key={index} scope={scope}>
          {(sessions) => sessions.length > 0 ? <ContextRail sessions={sessions} width={width} slot={slot} /> : null}
        </Provider>
      ))}
    </div>
  );
}

function tierOf(width: number): Tier {
  return width >= DOCK_MIN ? "dock" : width >= STRIP_MIN ? "strip" : "head";
}

function ContextRail({ sessions, width, slot }: {
  readonly sessions: readonly ContextRailSession[];
  readonly width: number;
  readonly slot: HTMLElement | null;
}) {
  const t = useT();
  const state = useContextRailState();
  const tier = tierOf(width);
  // 보는 세션이 맨 위에 선다. 나머지는 제공자가 준 순서(지휘관, 구성원)를 지킨다.
  const ordered = React.useMemo(() => [...sessions.filter((session) => session.focus), ...sessions.filter((session) => !session.focus)], [sessions]);
  // 제목 pill 이 읽힐 폭을 잃으면 칩이 먼저 양보한다 — 세션 칩들을 원호 하나로 합치고 누르면 카드가 함께 뜬다.
  const probe = React.useRef<HTMLSpanElement | null>(null);
  const yielded = useTitleYield(probe, state.enabled && tier === "head", width, ordered.length);
  const merged = yielded >= 1;
  // 합쳐도 제목이 모자라면 칩과 ▥ 단추가 머리 줄을 비우고 머리 아래 떠 있는 줄로 내려앉는다.
  const floating = yielded >= 2;
  const shownChips = merged ? 0 : headChipCount(ordered.length);
  // 머리 칩 단계: 칩을 누르면 그 세션의 카드가, `+n`을 누르면 칩으로 서지 못한 세션들의 카드가 뜬다.
  const flyoutCards = state.flyout === null ? [] : state.flyout === MORE_ID ? ordered.slice(shownChips) : ordered.filter((session) => session.id === state.flyout);

  // `/context`는 카드 열에서는 카드를 펼치고(기억에 이미 반영됐다), 칩 단계에서는 그 칩의 카드를 띄운다.
  const handled = React.useRef(state.reveal?.nonce ?? 0);
  React.useEffect(() => {
    const reveal = state.reveal;
    if (!reveal || reveal.nonce === handled.current) return;
    handled.current = reveal.nonce;
    if (tier !== "dock" && ordered.some((session) => session.id === reveal.id)) setContextFlyout(reveal.id);
  }, [state.reveal, tier, ordered]);

  // 떠 있는 카드는 밖을 누르거나 Esc로 닫는다. 떠 있을 때만 문서에 손을 댄다.
  const flyoutId = state.flyout;
  React.useEffect(() => {
    if (flyoutId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-context-rail-keep]")) return;
      setContextFlyout(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setContextFlyout(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [flyoutId]);
  // 단계가 바뀌면 떠 있던 카드는 닫는다 — 다른 자리의 카드로 옮겨 서지 않는다.
  React.useEffect(() => { setContextFlyout(null); }, [tier, state.enabled]);

  const toggle = (
    <button
      type="button"
      className="context-rail-toggle"
      aria-pressed={state.enabled}
      aria-label={t(state.enabled ? "conversation.rail.hide" : "conversation.rail.show")}
      title={t(state.enabled ? "conversation.rail.hide" : "conversation.rail.show")}
      onClick={() => setContextRailEnabled(!state.enabled)}
    >
      <RailGlyph />
    </button>
  );
  const headChips = state.enabled && tier === "head" ? (
    <HeadChips sessions={ordered} shown={shownChips} flyout={state.flyout} t={t} />
  ) : null;

  return (
    <>
      <span ref={probe} hidden />
      {floating ? <div className="context-rail-float" data-context-rail-keep>{headChips}{toggle}</div> : slot ? createPortal(<>{headChips}{toggle}</>, slot) : null}
      {state.enabled && tier === "dock" ? <DockColumn sessions={ordered} state={state} t={t} /> : null}
      {state.enabled && tier === "strip" ? <StripColumn sessions={ordered} flyout={state.flyout} state={state} t={t} /> : null}
      {state.enabled && tier === "head" && flyoutCards.length > 0 ? (
        <div className={`context-rail-fly is-head${floating ? " is-float" : ""}`} data-context-rail-keep>
          {flyoutCards.map((session) => <ContextCard key={session.id} session={session} open forced state={state} t={t} />)}
        </div>
      ) : null}
    </>
  );
}

function DockColumn({ sessions, state, t }: { readonly sessions: readonly ContextRailSession[]; readonly state: ContextRailState; readonly t: Translate }) {
  return (
    <aside className="context-rail is-dock" aria-label={t("conversation.rail.title")}>
      <div className="context-rail-title">{t("conversation.rail.title")}</div>
      {sessions.map((session) => (
        <ContextCard key={session.id} session={session} open={isContextCardOpen(state.memory, session.id, session.focus)} forced={false} state={state} t={t} />
      ))}
    </aside>
  );
}

function StripColumn({ sessions, flyout, state, t }: { readonly sessions: readonly ContextRailSession[]; readonly flyout: string | null; readonly state: ContextRailState; readonly t: Translate }) {
  return (
    <aside className="context-rail is-strip" aria-label={t("conversation.rail.title")}>
      {sessions.map((session) => {
        const label = chipLabel(session, t);
        return (
          <div className="context-rail-chip-wrap" key={session.id}>
            <button
              type="button"
              className={`context-rail-chip${session.measure?.stale ? " is-stale" : ""}${toneOf(session.measure)}`}
              data-context-rail-keep
              aria-expanded={flyout === session.id}
              aria-label={label}
              title={label}
              onClick={() => setContextFlyout(flyout === session.id ? null : session.id)}
            >
              <ContextArc ratio={ratioOf(session.measure)} size={18} />
              <strong>{session.measure ? `${percentOf(session.measure)}%` : "—"}</strong>
              <span className="context-rail-chip-name">{session.name.slice(0, 2)}</span>
            </button>
            {flyout === session.id ? (
              <div className="context-rail-fly is-strip" data-context-rail-keep>
                <ContextCard session={session} open forced state={state} t={t} />
              </div>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}

/** 제목이 이 폭 아래로 줄면(또는 pill 이 제목을 접으면) 칩을 합치고, 그래도 모자라면 머리 줄을 비운다. */
const TITLE_MIN = 110;

/**
 * 머리 칩이 제목을 밀어내는지 본다. 단계(폭)나 세션 수가 바뀔 때마다 풀어서 다시 재고, 밀어냈으면 합친 채로 둔다 — 합친 뒤의
 * 제목 폭은 칩이 줄어든 결과이므로 그 값으로 다시 풀지 않는다(깜빡임 방지).
 */
function useTitleYield(probe: React.RefObject<HTMLElement | null>, active: boolean, width: number, sessions: number): 0 | 1 | 2 {
  const [level, setLevel] = React.useState<0 | 1 | 2>(0);
  React.useLayoutEffect(() => { setLevel(0); }, [active, width, sessions]);
  // 머리 칩 단계에서는 제목 pill 이 가운데에 묶이지 않고 칸 왼쪽부터 남는 폭을 쓴다(CSS 가 이 표식을 읽는다). 제목이 잘려야 하면
  // 보조 글자(「· 구성원 1」)는 조각으로 남기지 않고 통째로 숨긴다 — 숨긴 뒤에는 폭이 바뀔 때까지 그대로 둔다(깜빡임 방지).
  React.useLayoutEffect(() => {
    if (!active) return;
    const column = probe.current?.closest<HTMLElement>(".conversation-column");
    const pill = column?.querySelector<HTMLElement>(":scope > .conversation-pill-row > .conversation-pill");
    if (!column || !pill) return;
    column.setAttribute("data-rail-head", "");
    pill.removeAttribute("data-rail-sub-hidden");
    // 셸의 도구 예약은 「⋯」가 서기 전의 캡슐 폭으로 잴 때가 있어 칩이 붙은 캡슐 아래로 알약이 파고든다. 칩이 선 단계에서는 실제 캡슐 폭을
    // 따로 지켜 준다 — 알약과 캡슐 사이에 최소 12px.
    const row = pill.parentElement;
    const tools = document.querySelector<HTMLElement>(".conversation-pill-tools");
    const reserve = () => {
      if (!row || !tools) return;
      const right = Number.parseFloat(getComputedStyle(tools).right) || 0;
      row.style.setProperty("--rail-head-reserve", `${Math.ceil(tools.getBoundingClientRect().width + right + 12)}px`);
    };
    reserve();
    const toolsObserver = tools ? new ResizeObserver(reserve) : null;
    if (tools) toolsObserver?.observe(tools);
    let subWidth = 0;
    const check = () => {
      const title = pill.querySelector<HTMLElement>(".conversation-pill-title");
      const sub = pill.querySelector<HTMLElement>(".conversation-pill-sub");
      if (title === null) return;
      if (!pill.hasAttribute("data-rail-sub-hidden")) {
        if (title.scrollWidth > title.clientWidth + 1) { subWidth = sub?.offsetWidth ?? 0; pill.setAttribute("data-rail-sub-hidden", ""); }
        return;
      }
      // 숨긴 뒤에도 남는 자리가 보조 글자 폭보다 넉넉하면(순간적인 측정으로 숨겼을 수 있다) 다시 보인다. 여유를 둬서 오가지 않게 한다.
      const tools = document.querySelector<HTMLElement>(".conversation-pill-tools");
      if (subWidth > 0 && tools !== null && title.scrollWidth <= title.clientWidth + 1 && tools.getBoundingClientRect().left - pill.getBoundingClientRect().right > subWidth + 24) pill.removeAttribute("data-rail-sub-hidden");
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(pill);
    return () => { observer.disconnect(); toolsObserver?.disconnect(); row?.style.removeProperty("--rail-head-reserve"); column.removeAttribute("data-rail-head"); pill.removeAttribute("data-rail-sub-hidden"); };
  }, [probe, active, width, sessions]);
  React.useLayoutEffect(() => {
    if (!active || level === 2) return;
    // 제목 pill 은 이 대화 칸 머리 줄에 있다(도구 캡슐은 칸 밖 띠로 포털되므로 칸에서 찾는다).
    const pill = probe.current?.closest(".conversation-column")?.querySelector<HTMLElement>(":scope > .conversation-pill-row > .conversation-pill");
    if (!pill) return;
    const check = () => {
      const title = pill.querySelector<HTMLElement>(".conversation-pill-title");
      const squeezed = pill.getAttribute("data-compact") === "true" || (title !== null && title.clientWidth < TITLE_MIN);
      if (squeezed) setLevel((current) => current === 0 ? 1 : 2);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(pill);
    const mutation = new MutationObserver(check);
    mutation.observe(pill, { attributes: true, attributeFilter: ["data-compact"] });
    return () => { observer.disconnect(); mutation.disconnect(); };
  }, [probe, active, level, width, sessions]);
  return level;
}

function headChipCount(total: number): number {
  return total > HEAD_CHIPS ? HEAD_CHIPS - 1 : total;
}

function HeadChips({ sessions, shown: shownCount, flyout, t }: { readonly sessions: readonly ContextRailSession[]; readonly shown: number; readonly flyout: string | null; readonly t: Translate }) {
  const shown = sessions.slice(0, shownCount);
  const more = sessions.length - shown.length;
  return (
    <span className="context-rail-head-chips">
      {shown.map((session) => {
        const label = chipLabel(session, t);
        return (
          <button
            key={session.id}
            type="button"
            className={`context-rail-hchip${session.measure?.stale ? " is-stale" : ""}${toneOf(session.measure)}`}
            data-context-rail-keep
            aria-expanded={flyout === session.id}
            aria-label={label}
            title={label}
            onClick={() => setContextFlyout(flyout === session.id ? null : session.id)}
          >
            <ContextArc ratio={ratioOf(session.measure)} size={14} />
            {/* 짧은 이름 — 지휘관은 정해진 짧은 말, 나머지는 이름을 폭으로 말줄임한다. 자리가 모자라면 칩이 먼저 합쳐지고(+N) 이름째 물러난다. */}
            <span className="context-rail-hchip-name">{session.role === "commander" ? t("conversation.rail.chipCommander") : session.name}</span>
          </button>
        );
      })}
      {more > 0 ? (
        <button
          type="button"
          className="context-rail-hchip"
          data-context-rail-keep
          aria-expanded={flyout === MORE_ID}
          aria-label={shownCount === 0 ? t("conversation.rail.title") : t("conversation.rail.moreAria", { count: String(more) })}
          title={shownCount === 0 ? t("conversation.rail.title") : undefined}
          onClick={() => setContextFlyout(flyout === MORE_ID ? null : MORE_ID)}
        >
          {shownCount === 0 ? <ContextArc ratio={ratioOf(sessions[0]?.measure ?? null)} size={14} /> : null}
          {shownCount === 0 ? more : `+${more}`}
        </button>
      ) : null}
    </span>
  );
}

/** 머리 칩의 `+n`이 여는 카드 묶음의 자리. 세션 id와 겹치지 않는다. */
const MORE_ID = "\u0000more";

export function chipLabel(session: ContextRailSession, t: Translate): string {
  if (!session.measure) return t("conversation.rail.chipUnmeasured", { name: session.name });
  return t("conversation.rail.chipAria", { name: session.name, percent: String(percentOf(session.measure)), summary: summaryOf(session.measure) });
}

export function ratioOf(measure: ContextRailMeasure | null): number {
  return measure && measure.max > 0 ? measure.occupied / measure.max : 0;
}

export function percentOf(measure: ContextRailMeasure): number {
  return Math.round(ratioOf(measure) * 100);
}

function summaryOf(measure: ContextRailMeasure): string {
  return `${formatTokens(measure.occupied)} / ${formatTokens(measure.max)}`;
}

/**
 * 카드가 어느 계단에 서는지. quota 레일이 쓰는 세 단계를 그대로 물려받는다. 자동 압축이 켜져 있으면 임계선이 곧 위험선이고, 꺼져 있으면
 * 창을 다 쓰는 것 자체가 한계이므로 고정 비율로 돌아간다.
 */
export function toneOf(measure: ContextRailMeasure | null): "" | " is-warn" | " is-critical" {
  if (!measure || measure.max <= 0) return "";
  const limit = measure.compactAt !== undefined ? measure.compactAt / measure.max : 1;
  const ratio = measure.occupied / measure.max;
  if (ratio >= limit * 0.97) return " is-critical";
  if (ratio >= limit * 0.75) return " is-warn";
  return "";
}

/** 토큰 수를 사람이 읽는 크기로. 정확한 자릿수가 아니라 규모를 읽히는 표면이라 천 단위에서 접고, 백만은 M으로 적는다. */
function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const text = millions < 10 ? millions.toFixed(1) : String(Math.round(millions));
    return `${text.endsWith(".0") ? text.slice(0, -2) : text}M`;
  }
  const thousands = tokens / 1_000;
  return thousands < 10 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

export function ContextCard({ session, open, forced, state, t }: {
  readonly session: ContextRailSession;
  readonly open: boolean;
  /** 떠 있는 카드는 접히지 않는다. */
  readonly forced: boolean;
  readonly state: ContextRailState;
  readonly t: Translate;
}) {
  const measure = session.measure;
  const shown = forced || open;
  const summary = measure ? `${summaryOf(measure)} · ${percentOf(measure)}%` : t("conversation.rail.unmeasuredShort");
  const bodyId = `context-rail-card-${session.id}`;
  return (
    <section
      className={`context-rail-card${session.focus ? " is-focus" : ""}${measure ? toneOf(measure) : ""}${measure?.stale ? " is-stale" : ""}`}
      aria-label={t("conversation.rail.cardAria", { name: session.name })}
    >
      {forced ? (
        <div className="context-rail-card-head is-static">
          <span className="context-rail-glyph" aria-hidden="true">{glyphOf(session.role)}</span>
          <span className="context-rail-card-name">{session.name}</span>
          <span className="context-rail-card-sum">{summary}</span>
        </div>
      ) : (
        <button type="button" className="context-rail-card-head" aria-expanded={shown} aria-controls={bodyId} onClick={() => toggleContextCard(session.id, session.focus)}>
          <span className="context-rail-chev" aria-hidden="true">{shown ? "▾" : "▸"}</span>
          <span className="context-rail-glyph" aria-hidden="true">{glyphOf(session.role)}</span>
          <span className="context-rail-card-name">{session.name}</span>
          <span className="context-rail-card-sum">{summary}</span>
        </button>
      )}
      {shown ? (
        <div className="context-rail-card-body" id={bodyId}>
          {measure ? <ContextBody sessionId={session.id} measure={measure} footnote={session.footnote} state={state} t={t} /> : <p className="context-rail-muted">{t("conversation.rail.unmeasured")}</p>}
        </div>
      ) : null}
    </section>
  );
}

function glyphOf(role: ContextRailSession["role"]): string {
  return role === "commodore" ? "☁" : role === "commander" ? "✿" : "◆";
}

function ContextBody({ sessionId, measure, footnote, state, t }: {
  readonly sessionId: string;
  readonly measure: ContextRailMeasure;
  readonly footnote: string | undefined;
  readonly state: ContextRailState;
  readonly t: Translate;
}) {
  const rows = [...measure.slices].sort((left, right) => right.tokens - left.tokens);
  const reserved = measure.reserved ?? 0;
  // 내역은 마지막 측정의 것이고 총량은 그보다 새롭다. 그 차이는 아직 분해를 모르는 몫이므로 한 행으로 세운다.
  const measured = rows.reduce((sum, row) => sum + row.tokens, 0);
  const hasBreakdown = rows.length > 0;
  const pending = hasBreakdown ? Math.max(0, measure.occupied - measured) : 0;
  const free = Math.max(0, measure.max - measure.occupied - reserved);
  const share = (tokens: number) => `${((tokens / measure.max) * 100).toFixed(1)}%`;
  return (
    <>
      <div className="context-rail-bar" role="img" aria-label={summaryOf(measure)}>
        {hasBreakdown
          ? rows.map((row, index) => <i key={row.name} style={{ width: `${(row.tokens / measure.max) * 100}%`, "--context-rail-step": String(Math.min(index, 5)) } as React.CSSProperties} />)
          : <i style={{ width: `${(measure.occupied / measure.max) * 100}%`, "--context-rail-step": "0" } as React.CSSProperties} />}
        {pending > 0 ? <i className="is-pending" style={{ width: `${(pending / measure.max) * 100}%` }} /> : null}
      </div>
      <ul className="context-rail-rows">
        {hasBreakdown
          ? rows.map((row, index) => (
            <li key={row.name}>
              <span className="context-rail-swatch" style={{ "--context-rail-step": String(Math.min(index, 5)) } as React.CSSProperties} aria-hidden="true" />
              <span className="context-rail-name" title={row.name}>{row.name}</span>
              <span className="context-rail-tokens">{formatTokens(row.tokens)}</span>
              <span className="context-rail-share">{share(row.tokens)}</span>
            </li>
          ))
          : (
            <li>
              <span className="context-rail-swatch" style={{ "--context-rail-step": "0" } as React.CSSProperties} aria-hidden="true" />
              <span className="context-rail-name">{t("conversation.rail.used")}</span>
              <span className="context-rail-tokens">{formatTokens(measure.occupied)}</span>
              <span className="context-rail-share">{share(measure.occupied)}</span>
            </li>
          )}
        {pending > 0 ? (
          <li>
            <span className="context-rail-swatch is-pending" aria-hidden="true" />
            <span className="context-rail-name">{t("conversation.rail.pending")}</span>
            <span className="context-rail-tokens">{formatTokens(pending)}</span>
            <span className="context-rail-share">{share(pending)}</span>
          </li>
        ) : null}
        {reserved > 0 ? (
          <li className="is-free">
            <span className="context-rail-swatch is-free" aria-hidden="true" />
            <span className="context-rail-name">{t("conversation.rail.reserved")}</span>
            <span className="context-rail-tokens">{formatTokens(reserved)}</span>
            <span className="context-rail-share">{share(reserved)}</span>
          </li>
        ) : null}
        <li className="is-free">
          <span className="context-rail-swatch is-free" aria-hidden="true" />
          <span className="context-rail-name">{t("conversation.rail.free")}</span>
          <span className="context-rail-tokens">{formatTokens(free)}</span>
          <span className="context-rail-share">{share(free)}</span>
        </li>
      </ul>
      <FileDetail sessionId={sessionId} rows={measure.memoryFiles} state={state} t={t} />
      <McpDetail sessionId={sessionId} rows={measure.mcpTools} state={state} t={t} />
      <p className="context-rail-foot">{footnote ?? t(hasBreakdown ? "conversation.rail.foot" : "conversation.rail.footTotalOnly")}</p>
    </>
  );
}

/** 아직 문맥에 실리지 않은 항목은 0토큰으로 온다. 그 줄은 창을 나눠 갖는 몫이 아니라 목록일 뿐이라 숨긴다. */
function spentRows(rows: readonly ContextRailRow[]): ContextRailRow[] {
  return rows.filter((row) => row.tokens > 0).sort((left, right) => right.tokens - left.tokens);
}

function FileDetail({ sessionId, rows, state, t }: { readonly sessionId: string; readonly rows: readonly ContextRailRow[]; readonly state: ContextRailState; readonly t: Translate }) {
  const spent = spentRows(rows);
  if (spent.length === 0) return null;
  const key = `${sessionId}:mem`;
  const open = state.details.has(key);
  return (
    <div className="context-rail-detail">
      <DetailHead open={open} label={t("conversation.rail.memoryFiles")} tokens={spent.reduce((sum, row) => sum + row.tokens, 0)} count={spent.length} onToggle={() => toggleContextDetail(key)} />
      {open ? (
        <ul className="context-rail-rows is-sub">
          {spent.map((row) => (
            <li key={row.name}>
              <span className="context-rail-name" title={row.name}>{row.name}</span>
              <span className="context-rail-tokens">{formatTokens(row.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function McpDetail({ sessionId, rows, state, t }: { readonly sessionId: string; readonly rows: readonly ContextRailRow[]; readonly state: ContextRailState; readonly t: Translate }) {
  const spent = spentRows(rows);
  if (spent.length === 0) return null;
  const byServer = new Map<string, ContextRailRow[]>();
  for (const row of spent) byServer.set(row.server ?? "", [...(byServer.get(row.server ?? "") ?? []), row]);
  const servers = [...byServer.entries()]
    .map(([name, tools]) => ({ name, tools, tokens: tools.reduce((sum, row) => sum + row.tokens, 0) }))
    .sort((left, right) => right.tokens - left.tokens);
  const key = `${sessionId}:mcp`;
  const open = state.details.has(key);
  return (
    <div className="context-rail-detail">
      <DetailHead open={open} label={t("conversation.rail.mcpTools")} tokens={servers.reduce((sum, server) => sum + server.tokens, 0)} count={spent.length} onToggle={() => toggleContextDetail(key)} />
      {open ? servers.map((server) => {
        const serverKey = `${key}:${server.name}`;
        const serverOpen = state.details.has(serverKey);
        const label = server.name === "" ? "—" : server.name;
        return (
          <div className="context-rail-server" key={server.name}>
            <button type="button" className="context-rail-detail-head is-server" aria-expanded={serverOpen} onClick={() => toggleContextDetail(serverKey)}>
              <span className="context-rail-chev" aria-hidden="true">{serverOpen ? "▾" : "▸"}</span>
              <span className="context-rail-server-glyph" aria-hidden="true">{serverGlyph(server.name)}</span>
              <span className="context-rail-name" title={label}>{label}</span>
              <span className="context-rail-tokens">{formatTokens(server.tokens)}</span>
              <span className="context-rail-count" title={t(server.tools.length === 1 ? "conversation.rail.toolCount_one" : "conversation.rail.toolCount_other", { count: String(server.tools.length) })}>{server.tools.length}</span>
            </button>
            {serverOpen ? (
              <ul className="context-rail-rows is-sub">
                {server.tools.map((tool) => (
                  <li key={tool.name}>
                    <span className="context-rail-name" title={tool.name}>{toolLabel(tool.name, server.name)}</span>
                    <span className="context-rail-tokens">{formatTokens(tool.tokens)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      }) : null}
    </div>
  );
}

function DetailHead({ open, label, tokens, count, onToggle }: { readonly open: boolean; readonly label: string; readonly tokens: number; readonly count: number; readonly onToggle: () => void }) {
  return (
    <button type="button" className="context-rail-detail-head" aria-expanded={open} onClick={onToggle}>
      <span className="context-rail-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      <span className="context-rail-name">{label}</span>
      <span className="context-rail-tokens">{formatTokens(tokens)}</span>
      <span className="context-rail-count">{count}</span>
    </button>
  );
}

/** 도구 이름만 — SDK 는 `mcp__<서버>__<도구>` 로 말하고, 서버는 묶음 머리가 이미 말한다. */
function toolLabel(name: string, server: string): string {
  const prefix = `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
  if (server !== "" && name.startsWith(prefix)) return name.slice(prefix.length);
  const match = /^mcp__.+?__(.+)$/.exec(name);
  return match ? match[1]! : name;
}

/** 서버를 구분하는 글리프 — 이름의 첫 글자(영숫자). 이름이 없으면 점. */
function serverGlyph(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toUpperCase() : "·";
}

/** 원호 하나 — 눈금도 라벨도 없이 규모만 세운다. */
export function ContextArc({ ratio, size }: { readonly ratio: number; readonly size: number }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, ratio)) * circumference;
  return (
    <svg className="context-rail-arc" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle className="context-rail-arc-track" cx="8" cy="8" r={radius} />
      <circle className="context-rail-arc-fill" cx="8" cy="8" r={radius} strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`} />
    </svg>
  );
}

export function RailGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 3.5v9" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

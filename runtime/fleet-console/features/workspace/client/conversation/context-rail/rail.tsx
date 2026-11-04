import * as React from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../../core/client/src/i18n/index.js";
import type { ContextRailMeasure, ContextRailRow, ContextRailScope, ContextRailSession } from "../../../shared/context-rail.js";
import { useContextRailProviders } from "./registry.js";
import {
  setContextFlyout, setContextRailEnabled, toggleContextCard, toggleContextDetail, useContextRailState,
  type ContextRailState,
} from "./store.js";
import "./context-rail.css";

export type Translate = ReturnType<typeof useT>;

/**
 * 대화 칸 본문 위에 컨텍스트 창을 띄운다. 폭으로 단계를 나누지 않는다 — 어느 폭에서나 같은 칩이 채팅 우측 위(머리 아래)에
 * 세로로 쌓이고, 본문을 밀지 않는다. 레일은 오른쪽 패널을 열거나 닫지 않는다.
 *
 * `slot`은 대화 머리 오른쪽 끝의 자리다. 창을 켜고 끄는 단추만 거기에 선다.
 */
export function ContextRailHost({ scope, slot, children }: {
  readonly scope: ContextRailScope;
  readonly slot: HTMLElement | null;
  readonly children: React.ReactNode;
}) {
  const providers = useContextRailProviders();
  return (
    <div className="conversation-main">
      {children}
      {providers.map((Provider, index) => (
        <Provider key={index} scope={scope}>
          {(sessions) => sessions.length > 0 ? <ContextRail sessions={sessions} slot={slot} /> : null}
        </Provider>
      ))}
    </div>
  );
}

function ContextRail({ sessions, slot }: {
  readonly sessions: readonly ContextRailSession[];
  readonly slot: HTMLElement | null;
}) {
  const t = useT();
  const state = useContextRailState();
  // 보는 세션이 맨 위에 선다. 나머지는 제공자가 준 순서(지휘관, 구성원)를 지킨다.
  const ordered = React.useMemo(() => [...sessions.filter((session) => session.focus), ...sessions.filter((session) => !session.focus)], [sessions]);
  const stackRef = React.useRef<HTMLDivElement | null>(null);
  const chipRefs = React.useRef(new Map<string, HTMLDivElement>());
  const [flyTop, setFlyTop] = React.useState(0);
  const [bubbleTop, setBubbleTop] = React.useState(0);
  const [fade, setFade] = React.useState({ top: false, bottom: false });
  const overId = React.useRef<string | null>(null);
  const focusId = React.useRef<string | null>(null);
  const [bubbleId, setBubbleId] = React.useState<string | null>(null);
  const broughtIntoView = React.useRef<string | null>(null);
  const open = ordered.find((session) => session.id === state.flyout) ?? null;
  const bubble = ordered.find((session) => session.id === bubbleId && session.id !== state.flyout) ?? null;
  // 마우스가 칩 위에 있으면 그 칩이 이긴다. 포커스는 키보드(:focus-visible)일 때만 말풍선을 연다.
  const syncBubble = () => setBubbleId(overId.current ?? focusId.current);

  // `/context`는 그 세션의 상세 카드를 띄운다.
  const handled = React.useRef(state.reveal?.nonce ?? 0);
  React.useEffect(() => {
    const reveal = state.reveal;
    if (!reveal || reveal.nonce === handled.current) return;
    handled.current = reveal.nonce;
    if (ordered.some((session) => session.id === reveal.id)) setContextFlyout(reveal.id);
  }, [state.reveal, ordered]);

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

  React.useEffect(() => {
    if (state.flyout !== null && !ordered.some((session) => session.id === state.flyout)) setContextFlyout(null);
  }, [ordered, state.flyout]);

  const placeFloating = React.useCallback((scrollIntoView: boolean) => {
    const stack = stackRef.current;
    if (!stack) return;
    const overflow = stack.scrollHeight - stack.clientHeight > 1;
    const top = overflow && stack.scrollTop > 1;
    const bottom = overflow && stack.scrollTop + stack.clientHeight < stack.scrollHeight - 1;
    setFade((current) => current.top === top && current.bottom === bottom ? current : { top, bottom });
    const id = state.flyout ?? bubbleId;
    const node = id === null ? null : chipRefs.current.get(id) ?? null;
    if (state.flyout !== null && node && scrollIntoView && broughtIntoView.current !== state.flyout) {
      const top = node.offsetTop;
      const bottom = top + node.offsetHeight;
      if (top < stack.scrollTop) stack.scrollTop = top;
      else if (bottom > stack.scrollTop + stack.clientHeight) stack.scrollTop = bottom - stack.clientHeight;
      broughtIntoView.current = state.flyout;
    }
    if (state.flyout === null) broughtIntoView.current = null;
    const flyNode = state.flyout === null ? null : chipRefs.current.get(state.flyout) ?? null;
    if (flyNode) setFlyTop(Math.max(0, flyNode.offsetTop - stack.scrollTop));
    const bubbleNode = bubbleId === null ? null : chipRefs.current.get(bubbleId) ?? null;
    if (bubbleNode) setBubbleTop(Math.max(0, bubbleNode.offsetTop - stack.scrollTop + 8));
  }, [state.flyout, bubbleId]);

  React.useLayoutEffect(() => { placeFloating(true); }, [placeFloating, ordered]);
  // 독이 자라면 오버레이 높이가 CSS 변수로 줄고, 칩 줄의 넘침·페이드도 따라 갱신한다.
  React.useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => placeFloating(false));
    observer.observe(stack);
    return () => observer.disconnect();
  }, [placeFloating]);

  const toggleLabel = t(state.enabled ? "conversation.rail.hide" : "conversation.rail.show");
  const toggle = (
    <button
      type="button"
      className="context-rail-toggle"
      aria-pressed={state.enabled}
      aria-label={toggleLabel}
      title={toggleLabel}
      onClick={() => setContextRailEnabled(!state.enabled)}
    >
      <RailGlyph />
    </button>
  );

  return (
    <>
      {slot ? createPortal(toggle, slot) : null}
      {state.enabled ? (
        <div
          className="context-rail-overlay"
          role="group"
          aria-label={t("conversation.rail.title")}
          {...(fade.top ? { "data-fade-top": "" } : {})}
          {...(fade.bottom ? { "data-fade-bottom": "" } : {})}
        >
          <div ref={stackRef} className="context-rail-stack" onScroll={() => placeFloating(false)}>
            {ordered.map((session) => (
              <div
                key={session.id}
                className="context-rail-chip-slot"
                ref={(node) => {
                  if (node) chipRefs.current.set(session.id, node);
                  else chipRefs.current.delete(session.id);
                }}
              >
                <ContextChip
                  session={session}
                  open={state.flyout === session.id}
                  t={t}
                  onToggle={() => setContextFlyout(state.flyout === session.id ? null : session.id)}
                  onHover={(hover) => { overId.current = hover ? session.id : overId.current === session.id ? null : overId.current; syncBubble(); }}
                  onFocusChange={(focused) => { focusId.current = focused ? session.id : focusId.current === session.id ? null : focusId.current; syncBubble(); }}
                />
              </div>
            ))}
          </div>
          {bubble ? (
            <div className="context-rail-bubble" style={{ top: bubbleTop }} aria-hidden="true">
              <strong>{bubble.name}</strong>
              {bubble.measure
                ? <span className="context-rail-bubble-usage">{`${summaryOf(bubble.measure)} · ${percentOf(bubble.measure)}%`}</span>
                : <span className="context-rail-bubble-plain">{t("conversation.rail.unmeasuredShort")}</span>}
            </div>
          ) : null}
          {open ? (
            <div className="context-rail-fly" style={{ top: flyTop, maxHeight: `calc(100% - ${flyTop}px)` }} data-context-rail-keep>
              <ContextCard session={open} open forced state={state} t={t} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ContextChip({ session, open, t, onToggle, onHover, onFocusChange }: {
  readonly session: ContextRailSession;
  readonly open: boolean;
  readonly t: Translate;
  readonly onToggle: () => void;
  readonly onHover: (hover: boolean) => void;
  readonly onFocusChange: (focused: boolean) => void;
}) {
  const measure = session.measure;
  const label = chipLabel(session, t);
  return (
    <button
      type="button"
      className={`context-rail-chip${measure?.stale ? " is-stale" : ""}${toneOf(measure)}`}
      data-context-rail-keep
      aria-expanded={open}
      aria-label={label}
      onClick={onToggle}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) onFocusChange(true); }}
      onBlur={() => onFocusChange(false)}
    >
      <span className="context-rail-ring">
        <ContextRing ratio={ratioOf(measure)} unmeasured={measure === null} />
        <span className="context-rail-ring-face">{session.avatar}</span>
      </span>
      <span className={`context-rail-pct${measure ? "" : " is-none"}`}>{measure ? `${percentOf(measure)}%` : "—"}</span>
    </button>
  );
}

/** 지름 40px 링. 측정 전에는 채움 없이 점선만 그린다. */
function ContextRing({ ratio, unmeasured }: { readonly ratio: number; readonly unmeasured: boolean }) {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, ratio)) * circumference;
  return (
    <svg className="context-rail-ring-arc" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      {unmeasured ? (
        <circle className="context-rail-ring-track is-dashed" cx="20" cy="20" r={radius} strokeDasharray="2 3" />
      ) : (
        <>
          <circle className="context-rail-ring-track" cx="20" cy="20" r={radius} />
          <circle className="context-rail-ring-fill" cx="20" cy="20" r={radius} strokeLinecap="round" strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`} />
        </>
      )}
    </svg>
  );
}

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

/** 큰 사용량 줄의 점유 — 만 단위도 소수 한 자리를 남겨 125.9k 가 126k 로 둥글어지지 않게 한다. */
function formatPreciseTokens(tokens: number): string {
  if (tokens >= 1_000_000 || tokens < 1_000) return formatTokens(tokens);
  const text = (tokens / 1_000).toFixed(1);
  return `${text.endsWith(".0") ? text.slice(0, -2) : text}k`;
}

/** 호스트가 보내는 범주 이름. 모르면 회색이다. */
const CATEGORY_CLASS: Readonly<Record<string, string>> = {
  Messages: "is-messages",
  "MCP tools": "is-mcp",
  "System prompt": "is-prompt",
  Skills: "is-skills",
  "System tools": "is-tools",
  "MCP server instructions": "is-instructions",
};

function categoryClass(name: string): string {
  return CATEGORY_CLASS[name] ?? "is-other";
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
          <span className="context-rail-card-name">{session.name}</span>
          {/* 측정값이 있으면 큰 사용량 줄이 요약을 대신한다. 측정 전만 머리 줄에 짧은 말을 남긴다. */}
          {measure ? null : <span className="context-rail-card-sum">{summary}</span>}
        </div>
      ) : (
        <button type="button" className="context-rail-card-head" aria-expanded={shown} aria-controls={bodyId} onClick={() => toggleContextCard(session.id, session.focus)}>
          <span className="context-rail-chev" aria-hidden="true">{shown ? "▾" : "▸"}</span>
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
  const widthOf = (tokens: number) => ({ width: `${(tokens / measure.max) * 100}%` });
  return (
    <>
      <div className="context-rail-big">
        <strong>{t("conversation.rail.usedBig", { percent: String(percentOf(measure)) })}</strong>
        <span>{formatPreciseTokens(measure.occupied)} / {formatTokens(measure.max)}</span>
      </div>
      <div className="context-rail-bar" role="img" aria-label={summaryOf(measure)}>
        {hasBreakdown
          ? rows.map((row) => <i key={row.name} className={categoryClass(row.name)} style={widthOf(row.tokens)} />)
          : <i className="is-other" style={widthOf(measure.occupied)} />}
        {pending > 0 ? <i className="is-pending" style={widthOf(pending)} /> : null}
        {reserved > 0 ? <i className="is-reserved" style={widthOf(reserved)} /> : null}
      </div>
      <ul className="context-rail-rows">
        {hasBreakdown
          ? rows.map((row) => (
            <li key={row.name}>
              <span className={`context-rail-swatch ${categoryClass(row.name)}`} aria-hidden="true" />
              <span className="context-rail-name" title={row.name}>{row.name}</span>
              <span className="context-rail-tokens">{formatTokens(row.tokens)}</span>
              <span className="context-rail-share">{share(row.tokens)}</span>
            </li>
          ))
          : (
            <li>
              <span className="context-rail-swatch is-other" aria-hidden="true" />
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
          <li className="is-gap">
            <span className="context-rail-swatch is-reserved" aria-hidden="true" />
            <span className="context-rail-name">{t("conversation.rail.reserved")}</span>
            <span className="context-rail-tokens">{formatTokens(reserved)}</span>
            <span className="context-rail-share">{share(reserved)}</span>
          </li>
        ) : null}
        <li className={`is-free${reserved > 0 ? "" : " is-gap"}`}>
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

/** 원호 하나 — 눈금도 라벨도 없이 규모만 세운다. 모바일·인라인 칩이 쓴다. */
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

/** 떠 있는 창 — 둥근 테두리 안 우측 위에 작은 채워진 사각형. */
export function RailGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <rect x="2.5" y="3" width="15" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.5" y="6" width="4.5" height="5" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

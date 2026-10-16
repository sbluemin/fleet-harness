import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchView } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog, OPERATION_CATALOG_CHANGED_EVENT } from "@fleet-console/sdk/operations/browser";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ConsoleState, NewSessionTarget, OperationNode, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { closeNewSession, openNewSession, requestQuickLaunch, setActiveOperation } from "../../../../core/client/src/integration/store.js";
import { findVariantLaunchKind, QUICK_LAUNCH_PROMPT_MAX_CHARS, resolveSelection } from "../../../execution/client/quick-launch.js";
import { readQuickLaunchSelection } from "../../../execution/client/quick-launch-preferences.js";
import { readLaunchStartSurface, supportsChatStart, withStartSurface, writeLaunchStartSurface } from "../../../execution/client/launch-start-surface.js";
import { ChatBubbleIcon, TerminalViewIcon } from "../../../execution/client/components/start-view-glyphs.js";
import { TheaterAvatar } from "../theater-avatar.js";
import "./new-session.css";

/**
 * 본문 「새 세션 화면」 — Theater·그룹 머리 「+」와 팔레트 「New Operation」이 연다(승인안 ① A).
 *
 * 여는 것만으로는 아무것도 만들지 않는다. 첫 메시지를 보내야 Quick Launch(⌘J)와 같은 실행 의도(requestQuickLaunch)로
 * 나가고, 실행은 Operations 화면이 맡는다 — 새 서버 계약은 없다. 가운데 카드는 「어디서」(Theater·그룹)와 「이어서」(이 Theater 의
 * 최근 대화)를, 아래 칩 줄은 지금 실행 좌표(Theater · 시작 보기 · 모델)를 늘 보인다. 모델·강도 칩은 컴포저 칩 작업이 이 자리에
 * 세운다 — 그 전까지는 기억된(없으면 기본) 모델로 실행하고 그 이름만 말한다.
 *
 * 시작 보기의 기억은 '+' 입구의 것(launch-start-surface)을 그대로 잇는다 — 이 화면이 그 입구의 메뉴를 대신한다.
 */
export function NewSessionColumn({ state, target, tools }: {
  readonly state: ConsoleState;
  readonly target: NewSessionTarget;
  readonly tools: ReactNode;
}) {
  const t = useT();
  const theater = state.theaters.find((candidate) => candidate.id === target.theaterId) ?? null;
  const group = target.groupId === null ? null : state.groups.find((candidate) => candidate.id === target.groupId) ?? null;
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [startView, setStartView] = useState<OperationLaunchView>(readLaunchStartSurface);
  const [starting, setStarting] = useState(false);
  const [theaterMenuOpen, setTheaterMenuOpen] = useState<"chip" | "card" | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const columnRef = useRef<HTMLDivElement | null>(null);

  // 열 때마다 카탈로그를 새로 읽는다(Quick Launch 와 같은 규칙) — 설정에서 켠 모델이 바로 보인다.
  useEffect(() => {
    let abort = new AbortController();
    const load = () => {
      abort.abort();
      abort = new AbortController();
      const signal = abort.signal;
      void fetchOperationCatalog(signal)
        .then((next) => { if (!signal.aborted) setCatalog(next); })
        .catch(() => { if (!signal.aborted) setCatalog((current) => current ?? []); });
    };
    load();
    window.addEventListener(OPERATION_CATALOG_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(OPERATION_CATALOG_CHANGED_EVENT, load);
      abort.abort();
    };
  }, []);

  // 대상(Theater·그룹)이 바뀌면 입력으로 돌아간다 — 다른 Theater 로 옮겨도 쓰던 문장은 그대로다.
  useEffect(() => { inputRef.current?.focus(); }, [target.theaterId, target.groupId]);

  // 사라진 Theater(잊음)는 화면을 걷는다. 그룹만 사라졌으면 Theater 에 그대로 선다(아래 groupId 가 그 그룹을 싣지 않는다).
  useEffect(() => { if (theater === null) closeNewSession(); }, [theater]);
  const groupId = group?.id ?? null;

  // 실행이 거절되면 Operations 화면이 초안을 Quick Launch 시트로 되돌린다 — 그 시트가 초안을 쥐었으니 이 화면은 물러난다.
  useEffect(() => { if (starting && state.quickLaunchOpen) closeNewSession(); }, [starting, state.quickLaunchOpen]);

  const variantTarget = useMemo(() => (catalog ? findVariantLaunchKind(catalog) : null), [catalog]);
  const groups = variantTarget?.kind.variants ?? [];
  const selection = useMemo(() => resolveSelection(groups, readQuickLaunchSelection()), [groups]);
  const chatAvailable = variantTarget !== null && supportsChatStart(variantTarget.kind);
  // 모델 밴드가 없는 실행 종류(설치 안 됨·로그인 필요 같은 사유 포함)는 「다른 시작」 카드에 선다 — 지운 '+' 메뉴의 직접 실행 칸을 잇는다.
  const directKinds = useMemo(() => (catalog ?? []).flatMap((plugin) => plugin.kinds
    .filter((kind) => !(variantTarget && plugin.id === variantTarget.pluginId && kind.id === variantTarget.kind.id))
    .filter((kind) => !kind.variants || kind.variants.length === 0)
    .map((kind) => ({ pluginId: plugin.id, kind }))), [catalog, variantTarget]);

  const recent = useMemo<OperationNode | null>(() => state.operations
    .filter((operation) => operation.theaterId === target.theaterId)
    .reduce<OperationNode | null>((best, operation) => (best === null || operation.ts.updatedAt > best.ts.updatedAt ? operation : best), null), [state.operations, target.theaterId]);

  const text = prompt.trim();
  const tooLong = text.length > QUICK_LAUNCH_PROMPT_MAX_CHARS;
  const canStart = theater !== null && variantTarget !== null && selection.model !== null && text.length > 0 && !tooLong && !starting;

  const start = () => {
    if (!canStart || !theater || !variantTarget) return;
    const variant: Record<string, string> = { prompt: text };
    if (selection.model) variant.model = selection.model;
    if (selection.effort) variant.effort = selection.effort;
    setStarting(true);
    requestQuickLaunch({
      theaterId: theater.id,
      pluginId: variantTarget.pluginId,
      kind: variantTarget.kind,
      variant: withStartSurface(variant, variantTarget.kind, startView) ?? variant,
      groupId,
    });
    // 새 Operation 이 서면 그 포커스가 이 화면을 걷는다(store 의 focusOperation). 그동안은 시작하는 중으로 선다.
  };

  const launchDirect = (pluginId: string | null, kind: OperationLaunchKind) => {
    if (!theater || kind.disabled) return;
    setStarting(true);
    requestQuickLaunch({ theaterId: theater.id, pluginId, kind, variant: {}, groupId });
  };

  // 실행 의도가 Operation 을 세우지 못한 채 끝나도(포커스할 것이 없음) 화면이 시작하는 중에 갇히지 않게 한다.
  useEffect(() => {
    if (!starting) return;
    const timer = window.setTimeout(() => closeNewSession(), 20_000);
    return () => window.clearTimeout(timer);
  }, [starting]);

  const toggleView = () => {
    const next: OperationLaunchView = startView === "chat" ? "terminal" : "chat";
    setStartView(next);
    writeLaunchStartSurface(next);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (theaterMenuOpen) return;
    event.preventDefault();
    closeNewSession();
  };

  const theaterName = theater ? theater.alias || theater.label : "";
  const viewLabel = t(startView === "chat" ? "conversation.newSession.viewChat" : "conversation.newSession.viewTerminal");

  return (
    <div className="conversation-column new-session" ref={columnRef} onKeyDown={onKeyDown}>
      <div className="conversation-pill-row">
        <span className="new-session-title">{t("conversation.newSession.title")}</span>
        <button type="button" className="new-session-cancel" onClick={closeNewSession} aria-label={t("conversation.newSession.cancel")} title={t("conversation.newSession.cancel")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        {tools}
      </div>
      <div className="new-session-body">
        <div className="new-session-cards">
          <section className="new-session-section" aria-labelledby="new-session-where">
            <h2 className="new-session-heading" id="new-session-where">{t("conversation.newSession.where")}</h2>
            <div className="new-session-card">
              <div className="new-session-row is-current" aria-current="true">
                {theater ? <TheaterAvatar theaterId={theater.id} size={18} label={theaterName} decorative /> : null}
                <span className="new-session-row-label">{theaterName}</span>
                <span className="new-session-row-meta">{group ? t("conversation.newSession.group", { name: group.name }) : t("conversation.newSession.currentTheater")}</span>
              </div>
              {state.theaters.length > 1 ? (
                <span className="new-session-anchor">
                  <button type="button" className="new-session-row" aria-haspopup="menu" aria-expanded={theaterMenuOpen === "card"} onClick={() => setTheaterMenuOpen(theaterMenuOpen === "card" ? null : "card")}>
                    <span className="new-session-row-label">{t("conversation.newSession.otherTheater")}</span>
                    <ChevronGlyph />
                  </button>
                  {theaterMenuOpen === "card" ? <TheaterMenu theaters={state.theaters} current={target.theaterId} placement="below" onPick={(id) => { setTheaterMenuOpen(null); openNewSession({ theaterId: id, groupId: null }); }} onClose={() => setTheaterMenuOpen(null)} /> : null}
                </span>
              ) : null}
            </div>
          </section>
          {recent ? (
            <section className="new-session-section" aria-labelledby="new-session-continue">
              <h2 className="new-session-heading" id="new-session-continue">{t("conversation.newSession.continue")}</h2>
              <div className="new-session-card">
                <button type="button" className="new-session-row" onClick={() => setActiveOperation(recent.id)}>
                  <ClockGlyph />
                  <span className="new-session-row-label">{recent.title || t("conversation.newSession.resumeRecent")}</span>
                  <span className="new-session-row-meta">{t("conversation.newSession.resumeRecent")}</span>
                </button>
              </div>
            </section>
          ) : null}
          {directKinds.length > 0 ? (
            <section className="new-session-section" aria-labelledby="new-session-other">
              <h2 className="new-session-heading" id="new-session-other">{t("conversation.newSession.otherKinds")}</h2>
              <div className="new-session-card">
                {directKinds.map(({ pluginId, kind }) => (
                  <button key={`${pluginId}:${kind.id}`} type="button" className="new-session-row" disabled={kind.disabled === true || starting} onClick={() => launchDirect(pluginId, kind)} data-operation-launch-kind={kind.id}>
                    <span className="new-session-row-label">{kind.title}</span>
                    {kind.disabledReason ? <span className="new-session-row-meta">{kind.disabledReason}</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
      <div className="new-session-composer-zone">
        <div className={`new-session-composer${starting ? " is-starting" : ""}`}>
          <textarea
            ref={inputRef}
            className="new-session-input"
            rows={1}
            value={prompt}
            disabled={starting}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                start();
              }
            }}
            placeholder={t("conversation.newSession.placeholder")}
            aria-label={t("conversation.newSession.promptLabel")}
            spellCheck={false}
          />
          <button type="button" className="new-session-send" onClick={start} disabled={!canStart} aria-label={t("conversation.newSession.start")} title={t("conversation.newSession.start")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5V3.8M4.2 7.4 8 3.6l3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className="new-session-chips">
          <span className="new-session-anchor">
            <button type="button" className="new-session-chip" aria-haspopup="menu" aria-expanded={theaterMenuOpen === "chip"} disabled={state.theaters.length < 2 || starting} onClick={() => setTheaterMenuOpen(theaterMenuOpen === "chip" ? null : "chip")}>
              {theater ? <TheaterAvatar theaterId={theater.id} size={14} label={theaterName} decorative /> : null}
              <span>{theaterName}</span>
            </button>
            {theaterMenuOpen === "chip" ? <TheaterMenu theaters={state.theaters} current={target.theaterId} placement="above" onPick={(id) => { setTheaterMenuOpen(null); openNewSession({ theaterId: id, groupId: null }); }} onClose={() => setTheaterMenuOpen(null)} /> : null}
          </span>
          {chatAvailable ? (
            <button type="button" className="new-session-chip" onClick={toggleView} disabled={starting} aria-label={t("conversation.newSession.viewAria", { view: viewLabel })} title={t("conversation.newSession.viewAria", { view: viewLabel })}>
              <span className="new-session-chip-glyph" aria-hidden="true">{startView === "chat" ? <ChatBubbleIcon /> : <TerminalViewIcon />}</span>
              <span>{viewLabel}</span>
            </button>
          ) : null}
          <span className="new-session-chips-spacer" />
          {starting ? <span className="new-session-status" role="status">{t("conversation.newSession.starting")}</span> : null}
          {tooLong ? <span className="new-session-status is-alert" role="alert">{t("chrome.quickLaunch.tooLong", { over: String(text.length - QUICK_LAUNCH_PROMPT_MAX_CHARS) })}</span> : null}
          {/* 모델·강도 칩 자리 — 컴포저 칩 작업이 이 칸에 선택기를 세운다. 그 전까지는 실행될 모델의 이름만 말한다. */}
          {/* data-operation-launch-kind 는 실행 기능 투어(「Claude, 하나의 Gateway」)의 앵커다 — 지운 '+' 메뉴의 모델 행이 지던 자리를 잇는다. */}
          <span className="new-session-model-slot" data-slot="model-effort" {...(variantTarget ? { "data-operation-launch-kind": variantTarget.kind.id } : {})}>
            {selection.modelLabel ? (
              <span className="new-session-model" title={t("conversation.newSession.modelAria", { model: selection.modelLabel })}>
                {selection.modelLabel}{selection.effortLabel ? <span className="new-session-effort">{selection.effortLabel}</span> : null}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Theater 고르기 — 칩(위로)과 「다른 Theater…」 줄(아래로)이 같은 목록을 연다. 즉시 열리고(승인안 ②) Esc·바깥 클릭이 닫는다. */
function TheaterMenu({ theaters, current, placement, onPick, onClose }: {
  readonly theaters: readonly TheaterInfo[];
  readonly current: string;
  readonly placement: "above" | "below";
  readonly onPick: (theaterId: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // 열릴 때 한 번만 — 닫기 콜백은 렌더마다 새로 오므로 ref 로 읽는다(의존성에 두면 렌더마다 포커스를 첫 항목으로 되돌린다).
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? ref.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
    const onDown = (event: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && event.target instanceof Node && anchor.contains(event.target)) return;
      onCloseRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const anchor = ref.current?.parentElement?.querySelector<HTMLButtonElement>(":scope > button");
      onClose();
      anchor?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[at + 1] ?? items[0])?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[at - 1] ?? items[items.length - 1])?.focus();
    }
  };
  return (
    <div ref={ref} className={`new-session-menu is-${placement}`} role="menu" aria-label={t("conversation.newSession.theaterMenuAria")} onKeyDown={onKeyDown}>
      {theaters.map((theater) => (
        <button key={theater.id} type="button" role="menuitemradio" aria-checked={theater.id === current} className="new-session-menu-item" onClick={() => onPick(theater.id)}>
          <TheaterAvatar theaterId={theater.id} size={16} label={theater.alias || theater.label} decorative />
          <span className="new-session-row-label">{theater.alias || theater.label}</span>
          {theater.id === current ? <span className="new-session-menu-check" aria-hidden="true">✓</span> : null}
        </button>
      ))}
    </div>
  );
}

const ChevronGlyph = () => (
  <svg className="new-session-row-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.2 8 9.7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const ClockGlyph = () => (
  <svg className="new-session-row-glyph" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M8 5.4V8l1.8 1.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
);

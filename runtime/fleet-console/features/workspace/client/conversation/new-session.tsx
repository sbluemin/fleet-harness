import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { OperationCatalogPlugin, OperationLaunchKind, OperationLaunchView } from "@fleet-console/sdk/operations";
import { fetchOperationCatalog, OPERATION_CATALOG_CHANGED_EVENT } from "@fleet-console/sdk/operations/browser";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { ConsoleState, NewSessionTarget, TheaterInfo } from "../../../../core/client/src/integration/types.js";
import { closeNewSession, openNewSession, requestQuickLaunch } from "../../../../core/client/src/integration/store.js";
import { DirectoryBrowserModal } from "../../../../core/client/src/chrome/components/directory-browser-modal.js";
import { findVariantLaunchKind, QUICK_LAUNCH_PROMPT_MAX_CHARS, resolveSelection } from "../../../execution/client/quick-launch.js";
import { readQuickLaunchSelection, writeQuickLaunchTheater } from "../../../execution/client/quick-launch-preferences.js";
import { readLaunchStartSurface, supportsChatStart, withStartSurface, writeLaunchStartSurface } from "../../../execution/client/launch-start-surface.js";
import { ChatBubbleIcon, TerminalViewIcon } from "../../../execution/client/components/start-view-glyphs.js";
import { TheaterAvatar } from "../theater-avatar.js";
import { registerTheaterFromPath } from "../theater.js";
import { NewSessionPlayground } from "./new-session-playground.js";
import { NewSessionLaunchSlot, type NewSessionLaunchChoice } from "./new-session-launch-slot.js";
import { resolveNewSessionTheaterId } from "./new-session-entry.js";
import "./new-session.css";

/**
 * 본문 「새 세션 화면」 — 사이드바 맨 위 「+」·팔레트 「New Operation」·새 세션 단축키가 연다(승인안 ① A, v4).
 *
 * 여는 것만으로는 아무것도 만들지 않는다. 첫 메시지를 보내야 Quick Launch(⌘J)와 같은 실행 의도(requestQuickLaunch)로
 * 나가고, 실행은 Operations 화면이 맡는다 — 새 서버 계약은 없다. 가운데 「어디서」 카드와 아래 칩 줄 왼쪽은 Theater·시작 표면을,
 * 칩 줄 오른쪽은 모델·강도 칸(NewSessionLaunchSlot)을 둔다. 시작해 Operation 이 되면 그 컴포저는 지금 그대로다 — 이 칩들은 여기에만 선다.
 *
 * Theater 가 없거나 새로 더할 때는 이 화면에서 「Theater 추가…」로 폴더를 고른다(사이드바 폴더 대화상자와 같은 등록 길). 더한 Theater 가
 * 곧 이번 세션의 Theater 다. 시작 보기의 기억은 '+' 입구의 것(launch-start-surface)을 그대로 잇는다.
 */
export function NewSessionColumn({ state, target, tools }: {
  readonly state: ConsoleState;
  readonly target: NewSessionTarget;
  readonly tools: ReactNode;
}) {
  const t = useT();
  // 고른 Theater 가 사라졌거나(잊음) 처음부터 없으면 기본 규칙으로 다시 고른다 — Theater 가 하나도 없으면 null.
  const theater = state.theaters.find((candidate) => candidate.id === target.theaterId)
    ?? state.theaters.find((candidate) => candidate.id === resolveNewSessionTheaterId())
    ?? null;
  const [catalog, setCatalog] = useState<readonly OperationCatalogPlugin[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [startView, setStartView] = useState<OperationLaunchView>(readLaunchStartSurface);
  const [starting, setStarting] = useState(false);
  const [theaterMenuOpen, setTheaterMenuOpen] = useState<"chip" | "card" | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [choice, setChoice] = useState<NewSessionLaunchChoice | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 열 때마다, 그리고 설정에서 모델을 켜고 끄면 카탈로그를 새로 읽는다(Quick Launch 와 같은 규칙).
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

  // Theater 가 바뀌면 입력으로 돌아간다 — 다른 Theater 로 옮겨도 쓰던 문장은 그대로다.
  useEffect(() => { inputRef.current?.focus(); }, [theater?.id]);

  // 실행이 거절되면 Operations 화면이 초안을 Quick Launch 시트로 되돌린다 — 그 시트가 초안을 쥐었으니 이 화면은 물러난다.
  useEffect(() => { if (starting && state.quickLaunchOpen) closeNewSession(); }, [starting, state.quickLaunchOpen]);

  const variantTarget = useMemo(() => (catalog ? findVariantLaunchKind(catalog) : null), [catalog]);
  const groups = variantTarget?.kind.variants ?? [];
  const remembered = useMemo(() => resolveSelection(groups, readQuickLaunchSelection()), [groups]);
  const launchChoice: NewSessionLaunchChoice = choice ?? { model: remembered.model, effort: remembered.effort };
  const chatAvailable = variantTarget !== null && supportsChatStart(variantTarget.kind);
  // 모델 밴드가 없는 실행 종류(설치 안 됨·로그인 필요 같은 사유 포함)는 「다른 시작」 카드에 선다 — 지운 '+' 메뉴의 직접 실행 칸을 잇는다.
  const directKinds = useMemo(() => (catalog ?? []).flatMap((plugin) => plugin.kinds
    .filter((kind) => !(variantTarget && plugin.id === variantTarget.pluginId && kind.id === variantTarget.kind.id))
    .filter((kind) => !kind.variants || kind.variants.length === 0)
    .map((kind) => ({ pluginId: plugin.id, kind }))), [catalog, variantTarget]);

  const text = prompt.trim();
  const tooLong = text.length > QUICK_LAUNCH_PROMPT_MAX_CHARS;
  const canStart = theater !== null && variantTarget !== null && launchChoice.model !== null && text.length > 0 && !tooLong && !starting;

  const pickTheater = (theaterId: string) => {
    setTheaterMenuOpen(null);
    // 고른 Theater 는 Quick Launch 와 같은 기억에 남는다 — 다음 새 세션·⌘J 가 같은 Theater 로 시작한다.
    writeQuickLaunchTheater(theaterId);
    openNewSession({ theaterId });
  };

  const addTheater = () => {
    setTheaterMenuOpen(null);
    setFolderDialogOpen(true);
  };

  const confirmFolder = (path: string) => {
    setFolderDialogOpen(false);
    void registerTheaterFromPath(path).then((theaterId) => { if (theaterId !== null) pickTheater(theaterId); });
  };

  const start = () => {
    if (!canStart || !theater || !variantTarget) return;
    const variant: Record<string, string> = { prompt: text };
    if (launchChoice.model) variant.model = launchChoice.model;
    if (launchChoice.effort) variant.effort = launchChoice.effort;
    setStarting(true);
    writeQuickLaunchTheater(theater.id);
    requestQuickLaunch({
      theaterId: theater.id,
      pluginId: variantTarget.pluginId,
      kind: variantTarget.kind,
      variant: withStartSurface(variant, variantTarget.kind, startView) ?? variant,
    });
    // 새 Operation 이 서면 그 포커스가 이 화면을 걷는다(store 의 focusOperation). 그동안은 시작하는 중으로 선다.
  };

  const launchDirect = (pluginId: string | null, kind: OperationLaunchKind) => {
    if (!theater || kind.disabled) return;
    setStarting(true);
    requestQuickLaunch({ theaterId: theater.id, pluginId, kind, variant: {} });
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
    // 폴더 대화상자는 포털이라 그 키도 React 트리를 타고 이 열까지 올라온다 — 대화상자의 Esc 는 대화상자만 닫는다.
    if (theaterMenuOpen || folderDialogOpen) return;
    event.preventDefault();
    closeNewSession();
  };

  const theaterName = theater ? theater.alias || theater.label : "";
  const viewLabel = t(startView === "chat" ? "conversation.newSession.viewChat" : "conversation.newSession.viewTerminal");
  const adding = state.addingTheater;

  return (
    <div className="conversation-column new-session" onKeyDown={onKeyDown}>
      <div className="conversation-pill-row">
        <span className="new-session-title">{t("conversation.newSession.title")}</span>
        <button type="button" className="new-session-cancel" onClick={closeNewSession} aria-label={t("conversation.newSession.cancel")} title={t("conversation.newSession.cancel")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        {tools}
      </div>
      <div className="new-session-body">
        <NewSessionPlayground state={state} theaterId={theater?.id ?? null} />
        <div className="new-session-cards">
          <section className="new-session-section" aria-labelledby="new-session-where">
            <h2 className="new-session-heading" id="new-session-where">{t("conversation.newSession.where")}</h2>
            <div className="new-session-card">
              {theater ? (
                <div className="new-session-row is-current" aria-current="true">
                  <TheaterAvatar theaterId={theater.id} size={18} label={theaterName} decorative />
                  <span className="new-session-row-label">{theaterName}</span>
                  <span className="new-session-row-meta">{t("conversation.newSession.currentTheater")}</span>
                </div>
              ) : null}
              {state.theaters.length > 1 ? (
                <span className="new-session-anchor">
                  <button type="button" className="new-session-row" aria-haspopup="menu" aria-expanded={theaterMenuOpen === "card"} onClick={() => setTheaterMenuOpen(theaterMenuOpen === "card" ? null : "card")}>
                    <span className="new-session-row-label">{t("conversation.newSession.otherTheater")}</span>
                    <ChevronGlyph />
                  </button>
                  {theaterMenuOpen === "card" ? <TheaterMenu theaters={state.theaters} current={theater?.id ?? null} placement="below" onPick={pickTheater} onAdd={addTheater} onClose={() => setTheaterMenuOpen(null)} /> : null}
                </span>
              ) : null}
              <button type="button" className="new-session-row" onClick={addTheater} disabled={adding || starting} data-new-session-add-theater="card">
                <FolderPlusGlyph />
                <span className="new-session-row-label">{t("conversation.newSession.addTheater")}</span>
              </button>
            </div>
          </section>
          {directKinds.length > 0 ? (
            <section className="new-session-section" aria-labelledby="new-session-other">
              <h2 className="new-session-heading" id="new-session-other">{t("conversation.newSession.otherKinds")}</h2>
              <div className="new-session-card">
                {directKinds.map(({ pluginId, kind }) => (
                  <button key={`${pluginId}:${kind.id}`} type="button" className="new-session-row" disabled={kind.disabled === true || starting || theater === null} onClick={() => launchDirect(pluginId, kind)} data-operation-launch-kind={kind.id}>
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
        {/* 칩 줄 — 왼쪽은 어디서(Theater·시작 표면), 오른쪽은 무엇으로(모델·강도 칸). 좁은 폭 접힘은 new-session.css 의 @container 가 정한다. */}
        <div className="new-session-chips">
          <div className="new-session-chips-row">
            <span className="new-session-chips-lead">
              {theater ? (
                <span className="new-session-anchor">
                  <button type="button" className="new-session-chip" aria-haspopup="menu" aria-expanded={theaterMenuOpen === "chip"} disabled={starting} onClick={() => setTheaterMenuOpen(theaterMenuOpen === "chip" ? null : "chip")}>
                    <TheaterAvatar theaterId={theater.id} size={14} label={theaterName} decorative />
                    <span className="new-session-chip-label">{theaterName}</span>
                  </button>
                  {theaterMenuOpen === "chip" ? <TheaterMenu theaters={state.theaters} current={theater.id} placement="above" onPick={pickTheater} onAdd={addTheater} onClose={() => setTheaterMenuOpen(null)} /> : null}
                </span>
              ) : (
                <button type="button" className="new-session-chip" onClick={addTheater} disabled={adding} data-new-session-add-theater="chip">
                  <span className="new-session-chip-glyph" aria-hidden="true"><FolderPlusGlyph /></span>
                  <span className="new-session-chip-label">{t("conversation.newSession.addTheater")}</span>
                </button>
              )}
              {chatAvailable ? (
                <button type="button" className="new-session-chip" onClick={toggleView} disabled={starting} aria-label={t("conversation.newSession.viewAria", { view: viewLabel })} title={t("conversation.newSession.viewAria", { view: viewLabel })}>
                  <span className="new-session-chip-glyph" aria-hidden="true">{startView === "chat" ? <ChatBubbleIcon /> : <TerminalViewIcon />}</span>
                  <span className="new-session-chip-label">{viewLabel}</span>
                </button>
              ) : null}
            </span>
            <span className="new-session-chips-trail">
              {starting ? <span className="new-session-status" role="status">{t("conversation.newSession.starting")}</span> : null}
              {tooLong ? <span className="new-session-status is-alert" role="alert">{t("chrome.quickLaunch.tooLong", { over: String(text.length - QUICK_LAUNCH_PROMPT_MAX_CHARS) })}</span> : null}
              {/* 모델·강도 칸 — data-operation-launch-kind 는 실행 기능 투어(「Claude, 하나의 Gateway」)의 앵커다. */}
              <span className="new-session-launch-slot" {...(variantTarget ? { "data-operation-launch-kind": variantTarget.kind.id } : {})}>
                <NewSessionLaunchSlot groups={groups} value={launchChoice} onChange={setChoice} disabled={starting} />
              </span>
            </span>
          </div>
        </div>
      </div>
      <DirectoryBrowserModal open={folderDialogOpen} onCancel={() => setFolderDialogOpen(false)} onConfirm={confirmFolder} />
    </div>
  );
}

/** Theater 고르기 — 칩(위로)과 「다른 Theater…」 줄(아래로)이 같은 목록을 연다. 맨 아래 「Theater 추가…」. 즉시 열리고 Esc·바깥 클릭이 닫는다. */
function TheaterMenu({ theaters, current, placement, onPick, onAdd, onClose }: {
  readonly theaters: readonly TheaterInfo[];
  readonly current: string | null;
  readonly placement: "above" | "below";
  readonly onPick: (theaterId: string) => void;
  readonly onAdd: () => void;
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
      <div className="new-session-menu-divider" role="separator" />
      <button type="button" role="menuitem" className="new-session-menu-item" onClick={onAdd} data-new-session-add-theater="menu">
        <FolderPlusGlyph />
        <span className="new-session-row-label">{t("conversation.newSession.addTheater")}</span>
      </button>
    </div>
  );
}

const ChevronGlyph = () => (
  <svg className="new-session-row-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.2 8 9.7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const FolderPlusGlyph = () => (
  <svg className="new-session-row-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.3h5.8v6.7h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 8v3M6.5 9.5h3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
);

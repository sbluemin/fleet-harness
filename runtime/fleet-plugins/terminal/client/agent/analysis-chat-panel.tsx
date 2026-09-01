import { React } from "@fleet-console/sdk/plugin/browser";
import { EffortTrack } from "@fleet-console/sdk/components/effort-track";
import {
  groupModelsByLaunchProvider,
  launchEtcGlyph,
  launchProviderCaption,
  launchProviderFromModelId,
  launchProviderGlyph,
} from "@fleet-console/sdk/components/launch-provider-glyphs";
import { Select } from "@fleet-console/sdk/react/browser";
import type { OperationLaunchVariantRow } from "@fleet-console/sdk/operations";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import { createPortal } from "react-dom";
import "@fleet-console/markdown/styles.css";

import { splitAnalystLedger, type AnalysisActivity, type AnalysisEntry, type AnalysisSegment, type AnalysisState, type AnalysisToolStep } from "./analysis-state.js";
import type { AnalysisModel } from "./analysis-types.js";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { diagramHydratorLabels, getT, translateServerMessage, type TerminalMessageKey } from "../i18n/index.js";
import { decorateEvidenceHtml } from "./analysis-evidence.js";
import { useAnalysisStore } from "./analysis-store.js";
import { closeAnalystCompanionPanels } from "./analysis-visibility.js";
import { AnalystArtifactsPanel } from "./analysis-artifacts-panel.js";
import { StreamedMarkdown } from "./streamed-markdown.js";

const SUGGESTIONS = [
  { icon: "◈", tone: "aurora", textKey: "terminal.analyst.suggestion.walkthrough" },
  { icon: "●", tone: "aurora", textKey: "terminal.analyst.suggestion.whatDoing" },
  { icon: "▲", tone: "coral", textKey: "terminal.analyst.suggestion.flagReview" },
  { icon: "≡", tone: "brass", textKey: "terminal.analyst.suggestion.handoffBrief" },
] as const satisfies readonly {
  readonly icon: string;
  readonly tone: string;
  readonly textKey: TerminalMessageKey;
}[];
const FOLLOW_UPS = [
  { icon: "◈", tone: "aurora", labelKey: "terminal.analyst.followup.goDeeper", textKey: "terminal.analyst.prompt.goDeeper" },
  { icon: "▲", tone: "coral", labelKey: "terminal.analyst.followup.intentDrift", textKey: "terminal.analyst.prompt.intentDrift" },
  { icon: "≡", tone: "brass", labelKey: "terminal.analyst.followup.toArtifact", textKey: "terminal.analyst.prompt.toArtifact" },
  { icon: "●", tone: "aurora", labelKey: "terminal.analyst.followup.whatDoingNow", textKey: "terminal.analyst.suggestion.whatDoing" },
] as const satisfies readonly {
  readonly icon: string;
  readonly tone: string;
  readonly labelKey: TerminalMessageKey;
  readonly textKey: TerminalMessageKey;
}[];
const SLASH_COMMANDS = [
  { command: "/now", descriptionKey: "terminal.analyst.slash.now", templateKey: "terminal.analyst.suggestion.whatDoing" },
  { command: "/drift", descriptionKey: "terminal.analyst.slash.drift", templateKey: "terminal.analyst.prompt.intentDrift" },
  { command: "/brief", descriptionKey: "terminal.analyst.slash.brief", templateKey: "terminal.analyst.prompt.handoffBriefArtifact" },
  { command: "/risks", descriptionKey: "terminal.analyst.slash.risks", templateKey: "terminal.analyst.prompt.flagReviewBeforeContinue" },
  { command: "/timeline", descriptionKey: "terminal.analyst.slash.timeline", templateKey: "terminal.analyst.prompt.walkthrough" },
] as const satisfies readonly {
  readonly command: string;
  readonly descriptionKey: TerminalMessageKey;
  readonly templateKey: TerminalMessageKey;
}[];

export function AnalystChatPanel({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch, send, stop, refreshCatalog } = useAnalysisStore(context);
  const language = context.language ?? "en";
  const t = getT(language);
  const reducedMotion = usePrefersReducedMotion();
  const [slashSelection, setSlashSelection] = React.useState(0);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  const hasInteracted = state.entries.length > 0;
  // 아티팩트는 드로어 안의 모드다 — 별도 컴패니언이 아니라 캡션 세그먼트가 이 본문을 가른다.
  const mode = state.viewMode;
  const chatRef = React.useRef<HTMLElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const latestEntry = state.entries.at(-1);
  const slashMatches = state.draft.startsWith("/")
    ? SLASH_COMMANDS.filter((item) => item.command.toLowerCase().startsWith(state.draft.toLowerCase()))
    : [];
  const slashOpen = !slashDismissed && slashMatches.length > 0;
  const slashListboxId = `analysis-${context.operationId}-slash-listbox`;
  const slashOptionId = (command: string) => `analysis-${context.operationId}-slash-${command.slice(1)}`;
  const activeSlashOption = slashOpen ? slashMatches[Math.min(slashSelection, slashMatches.length - 1)] : undefined;
  const evidenceTitle = t("terminal.analyst.evidenceCited");
  // 1Hz 티커는 이 패널에 단 하나 — 역사 턴마다 타이머가 쌓이지 않게 여기서 한 번 계산해 내려보낸다.
  const liveElapsedMs = useElapsedMs(state);
  const decorateEvidence = React.useCallback((html: string) => decorateEvidenceHtml(html, evidenceTitle), [evidenceTitle]);
  React.useLayoutEffect(() => {
    const chat = chatRef.current;
    if (!chat || !hasInteracted) return;
    chat.scrollTop = chat.scrollHeight;
  }, [hasInteracted, state.entries, state.latestActivity, state.phase, state.artifactAuthoring, state.artifactPublished, mode]);
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    resizeAnalysisTextarea(textarea);
  }, [state.draft, mode]);
  React.useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => resizeAnalysisTextarea(textarea));
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [mode]);
  React.useEffect(() => {
    const chat = chatRef.current;
    if (chat) installDiagramHydrator(chat, diagramHydratorLabels(language));
  }, [language, mode]);
  // 설정은 라우트라 다녀오면 이 패널은 다시 마운트되지만 store는 Operation 수명으로 살아 있다 —
  // 여는 시점에 한 번 읽어야 방금 추가한 게이트웨이 모델이 목록에 들어온다. 캡션도 같은 store를
  // 구독하므로 호출은 본문 한 곳에서만 한다(두 곳이면 열 때마다 두 번 읽는다).
  React.useEffect(() => { refreshCatalog(); }, [refreshCatalog]);
  const submit = async (text: string, clearDraft: boolean) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (state.busy) {
      dispatch({ type: "queue-push", text: trimmed });
      if (clearDraft) dispatch({ type: "set-draft", draft: "" });
      return;
    }
    if (clearDraft) dispatch({ type: "set-draft", draft: "" });
    await send(trimmed);
  };
  const selectSlashCommand = (index: number) => {
    const selected = slashMatches[index];
    if (!selected) return;
    dispatch({ type: "set-draft", draft: t(selected.templateKey) });
    setSlashDismissed(true);
    setSlashSelection(0);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const handleTranscriptClick = React.useCallback((event: React.MouseEvent<HTMLOListElement>) => {
    const target = event.target as HTMLElement;
    // 증거 칩 — 클릭은 점프가 아니라 질문이다: 분석가의 session_read가 근거를 맥락과 함께
    // 보여주도록 컴포저에 프리필한다(전송은 사용자 몫 — 메시지 한 건의 비용을 사용자가 쥔다).
    const evidence = target.closest<HTMLElement>("[data-analysis-evidence]");
    if (evidence) {
      const ref = evidence.getAttribute("data-analysis-evidence");
      if (ref) {
        dispatch({ type: "set-draft", draft: t("terminal.analyst.evidencePrompt", { ref }) });
        window.requestAnimationFrame(() => textareaRef.current?.focus());
      }
      return;
    }
    const button = target.closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    copyCodeToClipboard(button, code, language);
  }, [dispatch, language, t]);

  // 중단·전송은 초기 툴 줄과 도킹된 줄에서 같은 버튼이다 — 두 벌로 갈라 두면 한쪽만 고쳐지는 자리가 된다.
  const actions = (
    <>
      {state.busy ? (
        <button type="button" className="session-analyst__send session-analyst__stop" aria-label={t("terminal.analyst.stop")} onClick={() => void stop()}>
          <span aria-hidden="true" />
        </button>
      ) : null}
      <button type="submit" className="session-analyst__send" aria-label={t(state.busy ? "terminal.analyst.queueQuestion" : "terminal.analyst.send")} disabled={!state.draft.trim()}>
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
      </button>
    </>
  );

  const lastAnalystIndex = state.entries.reduce((last, entry, index) => entry.role === "analyst" ? index : last, -1);
  // 아직 분석가 chunk가 없는 진행/오류/중단은 합성 턴이 상태를 실어 나른다.
  const pendingTurn = state.phase !== "idle" && latestEntry?.role === "user"
    && (state.busy || state.phase === "error" || state.phase === "stopped");

  return (
    <section className={`session-analyst__chat-pane ${hasInteracted ? "has-interacted" : "is-initial"}`} aria-label={t("terminal.analyst.chatAria")} data-phase={state.phase}>
      {mode === "artifacts" ? <AnalystArtifactsPanel context={context} /> : (
      <div className="session-analyst__workspace">
        <section ref={chatRef} className="session-analyst__chat" aria-live="polite" aria-busy={state.busy}>
          {hasInteracted ? (
            <ol className="session-analyst__transcript" onClick={handleTranscriptClick}>
              {state.entries.map((entry, index) => entry.role === "user" ? (
                <li className="session-analyst__message session-analyst__message--user" key={`user-${index}`}>
                  <span className="session-analyst__ask-meta">
                    <span className="session-analyst__ask-who">{t("terminal.analyst.you")}</span>
                    {entry.at !== undefined ? <span>{formatClock(entry.at, language)}</span> : null}
                  </span>
                  <div className="session-analyst__ask-bubble">{entry.text}</div>
                </li>
              ) : (
                <AnalystTurn
                  key={`analyst-${index}`}
                  state={state}
                  language={language}
                  entry={entry}
                  isLast={index === lastAnalystIndex && !pendingTurn}
                  liveElapsedMs={liveElapsedMs}
                  decorateEvidence={decorateEvidence}
                />
              ))}
              {pendingTurn ? (
                <AnalystTurn state={state} language={language} entry={null} isLast liveElapsedMs={liveElapsedMs} decorateEvidence={decorateEvidence} />
              ) : null}
            </ol>
          ) : (
            <div className="session-analyst__hero-wrap">
              <header className="session-analyst__hero">
                <span className="session-analyst__sigil" aria-hidden="true">✳</span>
                <h2>{t("terminal.analyst.askAboutSession")}</h2>
                <p>{t("terminal.analyst.heroBody")}</p>
              </header>
              <div className="session-analyst__suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button type="button" key={suggestion.textKey} onClick={() => void submit(t(suggestion.textKey), false)}>
                    <span className="session-analyst__suggestion-icon" data-tone={suggestion.tone} aria-hidden="true">{suggestion.icon}</span>
                    {t(suggestion.textKey)}
                  </button>
                ))}
              </div>
              {state.phase === "error" ? <TurnPulse state={state} language={language} elapsedMs={liveElapsedMs} /> : null}
            </div>
          )}
          {state.artifactAuthoring || state.artifactPublished ? (
            <ArtifactAuthorCard
              state={state}
              language={language}
              onOpen={() => dispatch({ type: "view-mode", mode: "artifacts" })}
            />
          ) : null}
        </section>
        {state.queue.length > 0 ? (
          <div className="session-analyst__queue" aria-live="polite">
            {state.queue.map((text, index) => (
              <div className="session-analyst__queue-item" key={`${text}-${index}`}>
                <span className="session-analyst__queue-tag">{t("terminal.analyst.queued")}</span>
                <span className="session-analyst__queue-text">{text}</span>
                <button type="button" aria-label={t("terminal.analyst.cancelQueued", { "index + 1": index + 1 })} onClick={() => dispatch({ type: "queue-cancel", index })}>✕</button>
              </div>
            ))}
          </div>
        ) : null}
        {state.phase === "complete" && !state.busy && hasInteracted ? (
          <div className="session-analyst__followups">
            <span className="session-analyst__followups-label">{t("terminal.analyst.followUp")}</span>
            <div className="session-analyst__followups-row">
              {FOLLOW_UPS.map((item) => (
                <button type="button" key={item.labelKey} onClick={() => void submit(t(item.textKey), false)}>
                  <span className="session-analyst__suggestion-icon" data-tone={item.tone} aria-hidden="true">{item.icon}</span>
                  {t(item.labelKey)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <form className={`session-analyst__composer${state.busy ? " is-working" : ""}`} aria-busy={state.busy} onSubmit={(event) => { event.preventDefault(); void submit(state.draft, true); }}>
          {slashOpen ? (
            <div id={slashListboxId} className="session-analyst__slash" role="listbox" aria-label={t("terminal.analyst.commands")}>
              <span className="session-analyst__slash-heading">{t("terminal.analyst.commands")}</span>
              {slashMatches.map((item, index) => (
                <button
                  type="button"
                  id={slashOptionId(item.command)}
                  role="option"
                  aria-selected={index === slashSelection}
                  className={index === slashSelection ? "is-selected" : undefined}
                  key={item.command}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectSlashCommand(index)}
                >
                  <span>{item.command}</span>
                  <small>{t(item.descriptionKey)}</small>
                </button>
              ))}
            </div>
          ) : null}
          <div className="session-analyst__composer-surface">
            <label className="session-analyst__sr-only" htmlFor={`analysis-${context.operationId}`}>{t("terminal.analyst.askAboutSession")}</label>
            <textarea
              ref={textareaRef}
              id={`analysis-${context.operationId}`}
              role="combobox"
              aria-expanded={slashOpen}
              aria-controls={slashListboxId}
              aria-activedescendant={activeSlashOption ? slashOptionId(activeSlashOption.command) : undefined}
              rows={1}
              placeholder={t("terminal.analyst.composerPlaceholder")}
              value={state.draft}
              onChange={(event) => {
                dispatch({ type: "set-draft", draft: event.target.value });
                setSlashSelection(0);
                setSlashDismissed(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (slashOpen) {
                    setSlashDismissed(true);
                  } else if (state.draft) {
                    dispatch({ type: "set-draft", draft: "" });
                  } else {
                    closeAnalystCompanionPanels(context);
                  }
                  return;
                }
                if (slashOpen && !event.nativeEvent.isComposing) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSlashSelection((selection) => (selection + 1) % slashMatches.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSlashSelection((selection) => (selection - 1 + slashMatches.length) % slashMatches.length);
                    return;
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();
                    selectSlashCommand(Math.min(slashSelection, slashMatches.length - 1));
                    return;
                  }
                }
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit(state.draft, true);
              }}
            />
            {/* 좌표 레일 — 채팅뷰 컴포저와 같은 조립: 한 면 안에 입력 위층 + 컨트롤 아래층.
               좌표(모델·강도·슬래시)는 왼쪽, 전송·중단은 오른쪽. 첫 질문 뒤에도 그대로 선다 —
               잠긴 선택은 disabled가 말한다(두 벌 레이아웃은 한쪽만 고쳐지는 자리가 된다). */}
            <div className="session-analyst__composer-rail" aria-label={t("terminal.analyst.initialSettings")} onFocusCapture={() => setSlashDismissed(true)}>
              {/* 공급자 축은 고를 것이 둘 이상일 때만 컨트롤이 된다 — 항상 한 줄만 뜨는 메뉴는
                  자리를 차지하면서 아무것도 바꾸지 못한다. 값은 계속 선택에 실린다. */}
              {(state.catalog?.clis.length ?? 0) > 1 ? (
                <span className="session-analyst__select">
                  <Select
                    compact
                    label={t("terminal.analyst.cli")}
                    value={state.cliId}
                    disabled={state.started || state.selectionLocked || !state.catalog}
                    options={state.catalog?.clis.map((item) => ({ value: item.cliId, label: item.label, disabled: !item.available })) ?? []}
                    onChange={(cliId) => dispatch({ type: "select-cli", cliId })}
                  />
                </span>
              ) : null}
              <AnalystModelChip
                models={cli?.models ?? []}
                value={state.model}
                disabled={state.started || state.selectionLocked || !model}
                label={t("terminal.analyst.model")}
                menuLabel={t("terminal.analyst.modelMenu")}
                etcLabel={t("terminal.analyst.modelGroup.etc")}
                onChange={(nextModel) => dispatch({ type: "select-model", model: nextModel })}
              />
              {model && model.effortLevels.length > 0 ? (
                <span className="session-analyst__effort" inert={state.started || state.selectionLocked || undefined}>
                  <EffortTrack
                    row={analystEffortRow(model)}
                    value={state.effort}
                    onChange={(effort) => {
                      if (effort !== null) dispatch({ type: "select-effort", effort });
                    }}
                    autoLabel={t("terminal.analyst.effortAuto")}
                    autoSlot={false}
                    ariaLabel={t("terminal.analyst.effort")}
                    autoValueText={t("terminal.analyst.effortAutoValue")}
                    className="session-analyst__effort-track"
                  />
                </span>
              ) : (
                <span className="session-analyst__effort-na">{t("terminal.analyst.na")}</span>
              )}
              {/* 슬래시 목록은 placeholder 문구에만 있었다 — 읽고 지나가면 다시 만날 길이 없다. */}
              <button
                type="button"
                className="session-analyst__slash-hint"
                aria-label={t("terminal.analyst.commands")}
                onClick={() => {
                  dispatch({ type: "set-draft", draft: "/" });
                  setSlashDismissed(false);
                  setSlashSelection(0);
                  window.requestAnimationFrame(() => textareaRef.current?.focus());
                }}
              >{t("terminal.analyst.slashHint")}</button>
              <span
                className="session-analyst__saved"
                aria-live="polite"
                aria-atomic="true"
                style={{
                  opacity: state.selectionSaved ? 1 : 0,
                  transition: reducedMotion ? "none" : "opacity var(--duration-base) var(--ease-glide)",
                }}
              >{state.selectionSaved ? t("terminal.analyst.saved") : ""}</span>
              {actions}
            </div>
          </div>
          {state.busy ? <div className="session-analyst__composer-hint">{t("terminal.analyst.queueHint")}</div> : null}
        </form>
        {/* 받침 — 채팅뷰 settle과 동형. 첫 질문 전에는 flex-grow 0.8로 초대·컴포저를 중앙에
           세우고, 스트리밍이 시작되면 0으로 줄며 컴포저가 하단에 내려앉는다(비율 전환이라
           어떤 패널 높이에서도 같은 자리). */}
        <div className="session-analyst__settle" aria-hidden="true" />
      </div>
      )}
    </section>
  );
}

/* 캡션 밴드의 내용 — 정체·상태가 왼쪽, 초기화와 모드 세그먼트가 오른쪽.
   이 줄은 본문 위에 떠 있던 칩 줄을 대신한다: 떠 있는 줄은 첫 문단을 가리므로 본문이 그만큼의
   상단 패딩을 늘 비워 둬야 했고, 그 예약분은 캡션 높이보다 컸다. 호스트가 이미 캡션 높이만큼의
   자리를 비워 두므로, 여기로 옮기면 겹침도 예약분도 함께 사라진다. */
export function AnalystCaption({ context }: { readonly context: OperationRenderContext }) {
  const { state, dispatch, reset } = useAnalysisStore(context);
  const language = context.language ?? "en";
  const t = getT(language);
  const artifactCount = state.artifacts.length;
  const artifactAuthoring = state.artifactAuthoring !== null && artifactCount === 0;
  const mode = state.viewMode;
  const canReset = state.started || state.phase !== "idle" || state.draft.length > 0 || state.queue.length > 0 || state.entries.length > 0 || state.artifacts.length > 0;
  const previousArtifactCountRef = React.useRef(0);
  const [countPulseRevision, setCountPulseRevision] = React.useState(0);
  const artifactsChipRef = React.useRef<HTMLButtonElement>(null);
  const returnFocusRef = React.useRef(false);
  React.useEffect(() => {
    const previousCount = previousArtifactCountRef.current;
    previousArtifactCountRef.current = artifactCount;
    if (artifactCount === 0) {
      // 전량 삭제되면 볼 것이 없다 — 대화로 복귀하고, 포커스가 아티팩트 안이었다면 모드 칩으로 되돌린다.
      if (mode === "artifacts" && state.artifactAuthoring === null) {
        returnFocusRef.current = true;
        dispatch({ type: "view-mode", mode: "chat" });
      }
      return;
    }
    // 발행이 대화를 끌어내리지 않는다 — 인라인 발행 카드가 진입로, 배지 펄스가 신호를 진다.
    if (artifactCount > previousCount && mode === "chat") setCountPulseRevision((revision) => revision + 1);
  }, [artifactCount, dispatch, mode, state.artifactAuthoring]);
  // 비우기는 아티팩트 화면 안에서 일어난다 — 그 서브트리가 사라지며 포커스가 body로 떨어지고,
  // 아티팩트 세그먼트도 비활성이 된다. 활성 세그먼트(Chat)로 되돌린다. 되돌리는 시점은 모드가
  // 실제로 바뀐 렌더 이후여야 한다 — 같은 턴에서 프레임 콜백으로 넘기면 그 사이에 일어나는
  // 재렌더가 방금 준 포커스를 도로 걷어간다.
  React.useEffect(() => {
    if (!returnFocusRef.current || mode !== "chat") return;
    returnFocusRef.current = false;
    artifactsChipRef.current?.closest(".session-analyst__modechip")
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [mode]);
  return (
    <div className="session-analyst__chips" data-phase={state.phase}>
      <span className="session-analyst__chip session-analyst__chip--id">
        <i className="session-analyst__chip-dot" aria-hidden="true" />
        <span aria-hidden="true">✳</span>
        {t("terminal.analyst.chipTitle")}
        <span className="session-analyst__chip-state">· {stateLabel(state, language)}</span>
      </span>
      <span className="session-analyst__chip-cluster">
        <button
          type="button"
          className="session-analyst__chip"
          aria-label={t("terminal.analyst.resetAria")}
          onClick={() => { void reset().catch(() => {}); }}
          disabled={!canReset}
        >{t("terminal.analyst.reset")}</button>
        <span className="session-analyst__modechip" role="group" aria-label={t("terminal.analyst.viewMode")}>
          <button type="button" aria-pressed={mode === "chat"} onClick={() => dispatch({ type: "view-mode", mode: "chat" })}>{t("terminal.analyst.mode.chat")}</button>
          <button
            ref={artifactsChipRef}
            type="button"
            className={artifactAuthoring ? "is-authoring" : undefined}
            aria-pressed={mode === "artifacts"}
            disabled={artifactCount === 0 && !artifactAuthoring}
            title={artifactAuthoring ? t("terminal.analyst.authoringTooltip") : artifactCount === 0 ? t("terminal.analyst.artifactsEmptyTooltip") : undefined}
            onClick={() => dispatch({ type: "view-mode", mode: "artifacts" })}
          >
            {t("terminal.analyst.artifactsHandle")}
            {artifactCount > 0 ? <span key={countPulseRevision} className={`session-analyst__chip-count${countPulseRevision > 0 ? " is-pulsing" : ""}`}>{artifactCount}</span> : null}
            {artifactAuthoring ? <span className="session-analyst__chip-count">…</span> : null}
          </button>
        </span>
      </span>
    </div>
  );
}

/* 분석가 턴 — 채팅뷰 원장 문법: 스파인 노드가 상태를, 구간(문장+스텝)이 과정을,
   응답 seam 아래가 확정 답을 말한다. 끝난 턴의 과정은 fold 한 줄로 접힌다.
   entry=null이면 아직 아무 이벤트도 없는 진행/오류/중단의 합성 턴이다. 역사 턴은 봉인된
   entry.receipt만으로 그린다 — 전역 상태는 다음 send에서 이미 초기화됐다. */
function AnalystTurn({ state, language, entry, isLast, liveElapsedMs, decorateEvidence }: {
  readonly state: AnalysisState;
  readonly language: ConsoleLocale;
  readonly entry: (AnalysisEntry & { readonly role: "analyst" }) | null;
  readonly isLast: boolean;
  readonly liveElapsedMs: number;
  readonly decorateEvidence: (html: string) => string;
}) {
  const t = getT(language);
  const receipt = entry?.receipt;
  const working = isLast && state.busy;
  const liveError = isLast && state.phase === "error";
  const liveStopped = isLast && state.phase === "stopped";
  const isError = liveError || receipt?.outcome === "error";
  const isStopped = liveStopped || receipt?.outcome === "stopped";
  const { process, answer } = splitAnalystLedger(entry?.segments ?? []);
  const hasLedger = process.length > 0;
  const stepCount = receipt ? receipt.tools.length : state.tools.length;
  const stepsLabel = stepCount === 0 ? null : stepCount === 1 ? t("terminal.chat.oneStep") : t("terminal.chat.stepCount", { count: stepCount });
  const foldSummary = receipt?.outcome === "complete"
    ? `${t("terminal.analyst.turnAnswered", { elapsed: formatElapsed(receipt.durationMs) })}${stepsLabel ? ` · ${stepsLabel}` : ""}`
    : null;
  return (
    <li className={`session-analyst__message session-analyst__message--analyst${working ? " is-working" : ""}${isError ? " is-error" : ""}${!isError && isStopped ? " is-stopped" : ""}`}>
      <span className="session-analyst__turn-spine" aria-hidden="true"><span className="session-analyst__turn-node" /></span>
      <div className="session-analyst__turn-main">
        {/* 도는 동안의 시계는 채팅 원장과 같은 명도 물결을 진다 — 두 면이 같은 사실("이 턴이
            아직 살아 있다")을 말하므로 어휘가 갈리면 안 된다. */}
        {working ? (
          <div className="session-analyst__turn-head">
            <span className="session-analyst__live-text">{t("terminal.chat.turnWorking", { elapsed: formatElapsed(liveElapsedMs) })}</span>
          </div>
        ) : null}
        {/* 살아 있는 턴의 과정은 접지 않는다 — 원장이 곧 진행 표시다. */}
        {working && hasLedger ? (
          <div className="session-analyst__ledger">
            {process.map((segment, index) => (
              <LedgerSegment key={index} segment={segment} language={language} decorateEvidence={decorateEvidence} live={index === process.length - 1 && answer === null} />
            ))}
          </div>
        ) : null}
        {/* 끝난 턴의 과정은 fold 한 줄로 접힌다 — 채팅 원장의 접힘과 같은 문법. */}
        {!working && foldSummary !== null ? (
          hasLedger ? (
            <details className="session-analyst__receipt">
              <summary aria-label={t("terminal.chat.receiptAria")}>
                <span className="session-analyst__receipt-label">{foldSummary}</span>
                <span className="session-analyst__receipt-chev" aria-hidden="true">⌄</span>
              </summary>
              <div className="session-analyst__receipt-body">
                {process.map((segment, index) => (
                  <LedgerSegment key={index} segment={segment} language={language} decorateEvidence={decorateEvidence} live={false} />
                ))}
              </div>
            </details>
          ) : (
            <div className="session-analyst__receipt is-flat"><span className="session-analyst__receipt-label">{foldSummary}</span></div>
          )
        ) : null}
        {/* 이벤트가 아직 없을 때만 펄스가 선다 — 원장이 서면 원장이 진행을 말한다. */}
        {(working && !hasLedger && answer === null) || liveError ? <TurnPulse state={state} language={language} elapsedMs={liveElapsedMs} /> : null}
        {working && hasLedger ? <span className="session-analyst__truth-mark">{t("terminal.analyst.lastConfirmedOnly")}</span> : null}
        {liveStopped ? <StoppedReceipt state={state} language={language} elapsedMs={liveElapsedMs} /> : null}
        {!liveStopped && !working && receipt?.outcome === "stopped" ? (
          <div className="session-analyst__stopped" role="status">{t("terminal.analyst.stoppedAt", { elapsed: formatElapsed(receipt.durationMs) })}</div>
        ) : null}
        {!liveError && !working && receipt?.outcome === "error" ? (
          <div className="session-analyst__stopped is-error" role="status">{`${receipt.error ? translateServerMessage(language, receipt.error) : t("terminal.analyst.state.needsAttention")} · ${formatElapsed(receipt.durationMs)}`}</div>
        ) : null}
        {/* 실패·중단 턴의 과정도 역사에 남는다 — "무엇까지는 확인됐나"가 이 원장의 몫이다. */}
        {!working && receipt && receipt.outcome !== "complete" && hasLedger ? (
          <div className="session-analyst__ledger is-aftermath">
            {process.map((segment, index) => (
              <LedgerSegment key={index} segment={segment} language={language} decorateEvidence={decorateEvidence} live={false} />
            ))}
          </div>
        ) : null}
        {answer !== null ? (
          <div className="session-analyst__answer">
            <div className="session-analyst__answer-kicker" aria-hidden="true">{t("terminal.chat.answerLabel")}</div>
            <StreamedMarkdown className="session-analyst__response markdown-body" text={answer.text} streaming={working} language={language} transformHtml={decorateEvidence} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/* 구간 — 모델의 문장 하나와 그 문장으로 한 일. 문장은 공유 마크다운이, 스텝은 상태 글리프가 진다. */
function LedgerSegment({ segment, language, decorateEvidence, live }: {
  readonly segment: AnalysisSegment;
  readonly language: ConsoleLocale;
  readonly decorateEvidence: (html: string) => string;
  readonly live: boolean;
}) {
  return (
    <div className="session-analyst__seg">
      {segment.text !== "" ? (
        <StreamedMarkdown className="session-analyst__seg-text markdown-body" text={segment.text} streaming={false} language={language} transformHtml={decorateEvidence} />
      ) : null}
      {segment.steps.length > 0 ? (
        <div className="session-analyst__steps">
          {segment.steps.map((step) => <LedgerStep key={step.title} step={step} live={live} />)}
        </div>
      ) : null}
    </div>
  );
}

function LedgerStep({ step, live }: { readonly step: AnalysisToolStep; readonly live: boolean }) {
  const status = step.status.toLowerCase();
  const running = live && /pend|progress|running|start/.test(status);
  const failed = /fail|error|denied|reject/.test(status);
  const tone = running ? "live" : failed ? "fail" : "done";
  return (
    <div className="session-analyst__step" data-tone={tone}>
      <span className="session-analyst__step-mark" aria-hidden="true">{running ? "●" : failed ? "✕" : "✓"}</span>
      <strong>{step.title}</strong>
      <small>{step.status}</small>
    </div>
  );
}

/* 진행 펄스 행 — 마지막 확인 활동만 말한다는 정직성 마이크로카피가 함께 붙는다. */
function TurnPulse({ state, language, elapsedMs }: { readonly state: AnalysisState; readonly language: ConsoleLocale; readonly elapsedMs: number }) {
  const t = getT(language);
  const elapsed = formatElapsed(elapsedMs);
  const activity = activityLabel(state.latestActivity, language);
  const isError = state.phase === "error";
  const current = currentActivity(state.latestActivity, language);
  return (
    <>
      <div className={`session-analyst__pulse${isError ? " is-error" : ""}`} role={isError ? "alert" : "status"} aria-live={isError ? undefined : "polite"}>
        <span className="session-analyst__pulse-orbit" aria-hidden="true" />
        <span className="session-analyst__pulse-copy">
          <strong
            key={`${state.phase}-${current.label}`}
            className={isError ? undefined : "session-analyst__live-text"}
          >
            {isError ? translateServerMessage(language, state.error ?? "") : current.label}
          </strong>
          <small>{isError ? language === "ko" ? activity : `Last confirmed activity: ${activity}` : current.note}</small>
        </span>
        <time>{elapsed}</time>
      </div>
      {!isError ? <span className="session-analyst__truth-mark">{t("terminal.analyst.lastConfirmedOnly")}</span> : null}
    </>
  );
}

function StoppedReceipt({ state, language, elapsedMs }: { readonly state: AnalysisState; readonly language: ConsoleLocale; readonly elapsedMs: number }) {
  const t = getT(language);
  const elapsed = formatElapsed(elapsedMs);
  const activity = activityLabel(state.latestActivity, language);
  return <div className="session-analyst__stopped" role="status">{t("terminal.analyst.stoppedReceipt", { activity, elapsed })}</div>;
}

function resizeAnalysisTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  const style = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18.75;
  const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const maxHeight = (lineHeight * 6) + verticalPadding;
  const nextHeight = Math.max(36, Math.min(textarea.scrollHeight, maxHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function copyCodeToClipboard(button: HTMLElement, code: string, language: ConsoleLocale): void {
  const clipboard = navigator.clipboard;
  if (!clipboard) return;
  let write: Promise<void>;
  try { write = clipboard.writeText(code); } catch { return; }
  const original = button.textContent;
  const t = getT(language);
  void write.then(() => {
    if (!button.isConnected) return;
    button.textContent = t("terminal.analyst.copied");
    window.setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1_200);
  }).catch(() => undefined);
}

function ArtifactAuthorCard({ state, language, onOpen }: { readonly state: AnalysisState; readonly language: ConsoleLocale; readonly onOpen?: () => void }) {
  const t = getT(language);
  const authoringElapsedMs = useArtifactAuthoringElapsedMs(state.artifactAuthoring?.startedAt ?? null);
  if (state.artifactAuthoring) {
    return (
      <div className="session-analyst__author-card is-authoring">
        <div className="session-analyst__author-head">
          <span className="session-analyst__author-sigil" aria-hidden="true">✳</span>
          <strong className="session-analyst__author-title">{t("terminal.analyst.publishingArtifact")}</strong>
          <time className="session-analyst__author-time">{formatElapsed(authoringElapsedMs)}</time>
        </div>
        <p className="session-analyst__author-sub">{t("terminal.analyst.authoringBody")}</p>
        <div className="session-analyst__author-track" aria-hidden="true"><span /></div>
      </div>
    );
  }
  const published = state.artifactPublished;
  if (!published) return null;
  return (
    <div className="session-analyst__author-card is-done">
      <div className="session-analyst__author-head">
        <span className="session-analyst__author-sigil" aria-hidden="true">◆</span>
        <strong className="session-analyst__author-title">{t("terminal.analyst.artifactPublished", { title: published.artifact.title })}</strong>
        {published.durationMs === null ? null : <time className="session-analyst__author-time">{formatElapsed(published.durationMs)}</time>}
        {onOpen ? <button type="button" className="session-analyst__author-open" onClick={onOpen}>{t("terminal.analyst.openInArtifacts")}</button> : null}
      </div>
    </div>
  );
}

function currentActivity(activity: AnalysisActivity | null, language: ConsoleLocale): { readonly label: string; readonly note: string } {
  const t = getT(language);
  if (!activity || activity.kind === "starting") return {
    label: t("terminal.analyst.activity.starting"),
    note: t(activity?.connected ? "terminal.analyst.activity.connected" : "terminal.analyst.activity.startingSession"),
  };
  if (activity.kind === "reasoning") return { label: t("terminal.analyst.activity.reasoning"), note: t("terminal.analyst.activity.thoughtHidden") };
  if (activity.kind === "tool") return { label: t("terminal.analyst.activity.usingTool", { title: activity.title }), note: t("terminal.analyst.activity.toolStatus", { status: activity.status }) };
  return { label: t("terminal.analyst.activity.writing"), note: t("terminal.analyst.activity.answerChunk") };
}

function activityLabel(activity: AnalysisActivity | null, language: ConsoleLocale): string {
  const t = getT(language);
  if (!activity || activity.kind === "starting") return t("terminal.analyst.activity.starting");
  if (activity.kind === "reasoning") return t("terminal.analyst.activity.reasoning");
  if (activity.kind === "tool") return `${t("terminal.analyst.activity.usingTool", { title: activity.title })} (${activity.status})`;
  return t("terminal.analyst.activity.writing");
}

function stateLabel(state: AnalysisState, language: ConsoleLocale): string {
  const t = getT(language);
  if (state.phase === "error") return t("terminal.analyst.state.needsAttention");
  if (state.busy) return t("terminal.analyst.state.analyzing");
  if (state.phase === "complete") return t("terminal.analyst.state.complete");
  if (state.phase === "stopped") return t("terminal.analyst.state.stopped");
  return t("terminal.analyst.state.ready");
}

function formatClock(at: number, language: ConsoleLocale): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString(language === "ko" ? "ko-KR" : "en", { hour: "2-digit", minute: "2-digit" });
}

function useElapsedMs(state: AnalysisState): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!state.busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [state.busy, state.runStartedAt]);
  if (state.runStartedAt === null) return 0;
  return Math.max(0, (state.runEndedAt ?? now) - state.runStartedAt);
}

function useArtifactAuthoringElapsedMs(startedAt: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

function formatElapsed(elapsedMs: number): string {
  return `${Math.floor(elapsedMs / 1_000)}s`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function shortModelLabel(label: string, providerCaption?: string): string {
  const stripped = label.replace(/^Claude\s+/u, "");
  if (providerCaption && stripped.startsWith(`${providerCaption}-`)) {
    return stripped.slice(providerCaption.length + 1);
  }
  return stripped;
}

const ANALYST_MENU_MAX_HEIGHT = 520;
const ANALYST_MENU_MIN_HEIGHT = 120;
const ANALYST_MENU_MARGIN = 12;
const ANALYST_MENU_GAP = 8;
const ANALYST_MENU_WIDTH = 216;

function placeAnalystModelMenu(chip: HTMLElement): React.CSSProperties {
  const rect = chip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - ANALYST_MENU_GAP - ANALYST_MENU_MARGIN;
  const spaceAbove = rect.top - ANALYST_MENU_GAP - ANALYST_MENU_MARGIN;
  const openBelow = spaceBelow >= ANALYST_MENU_MIN_HEIGHT || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(
    ANALYST_MENU_MIN_HEIGHT,
    Math.min(ANALYST_MENU_MAX_HEIGHT, openBelow ? spaceBelow : spaceAbove),
  );
  const width = Math.min(ANALYST_MENU_WIDTH, viewportWidth - ANALYST_MENU_MARGIN * 2);
  const left = Math.min(
    Math.max(ANALYST_MENU_MARGIN, rect.left),
    viewportWidth - width - ANALYST_MENU_MARGIN,
  );
  const top = openBelow
    ? rect.bottom + ANALYST_MENU_GAP
    : Math.max(ANALYST_MENU_MARGIN, rect.top - ANALYST_MENU_GAP - maxHeight);
  return {
    position: "fixed",
    top,
    left,
    zIndex: 40,
    width,
    maxHeight,
    overflowY: "auto",
  };
}

function analystEffortRow(model: AnalysisModel): OperationLaunchVariantRow {
  return {
    id: model.id,
    label: model.label,
    launch: { model: model.id },
    effortAxis: [...model.effortLevels],
    chips: model.effortLevels.map((id) => ({
      id,
      label: id.toUpperCase(),
      launch: { model: model.id, effort: id },
    })),
  };
}

function AnalystModelChip({
  models,
  value,
  disabled,
  label,
  menuLabel,
  etcLabel,
  onChange,
}: {
  readonly models: readonly AnalysisModel[];
  readonly value: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly menuLabel: string;
  readonly etcLabel: string;
  readonly onChange: (model: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const chipRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = React.useState<React.CSSProperties>({});
  const selected = models.find((item) => item.id === value) ?? models[0];
  const selectedProvider = launchProviderFromModelId(selected?.id ?? value);
  const selectedCaption = selectedProvider ? launchProviderCaption(selectedProvider) : undefined;
  const groups = groupModelsByLaunchProvider(models);
  React.useLayoutEffect(() => {
    if (!open || !chipRef.current) return;
    setMenuStyle(placeAnalystModelMenu(chipRef.current));
  }, [open, models]);
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (chipRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      chipRef.current?.focus();
    };
    const onReposition = () => {
      if (chipRef.current) setMenuStyle(placeAnalystModelMenu(chipRef.current));
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`session-analyst__model-chip${selectedProvider ? ` is-${selectedProvider}` : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((current) => !current); }}
      >
        <span className="session-analyst__model-mark operation-launch-provider-glyph" aria-hidden="true">
          {selectedProvider ? launchProviderGlyph(selectedProvider) : launchEtcGlyph()}
        </span>
        <span className="session-analyst__model-chip-label">{selected ? shortModelLabel(selected.label, selectedCaption) : value}</span>
        <span className="session-analyst__model-chip-caret" aria-hidden="true">▾</span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
          <div ref={menuRef} className="session-analyst__model-menu theater-menu" role="menu" aria-label={menuLabel} style={menuStyle}>
            {groups.map((group, groupIndex) => {
              const caption = group.provider ? launchProviderCaption(group.provider) : etcLabel;
              return (
                <div key={group.provider ?? "etc"} role="group" aria-label={caption}>
                  {groupIndex > 0 ? <div className="theater-menu-divider" role="separator" /> : null}
                  <p className={`operation-launch-variant-caption${group.provider ? ` is-${group.provider}` : ""}`}>
                    <span className={`operation-launch-provider-glyph${group.provider ? "" : " operation-launch-provider-glyph--etc"}`} aria-hidden="true">
                      {group.provider ? launchProviderGlyph(group.provider) : launchEtcGlyph()}
                    </span>
                    <span>{caption}</span>
                  </p>
                  {group.models.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="operation-launch-variant-row"
                      role="menuitemradio"
                      aria-checked={item.id === value}
                      onClick={() => {
                        onChange(item.id);
                        setOpen(false);
                        chipRef.current?.focus();
                      }}
                    >
                      <span className="operation-launch-variant-row-label">{shortModelLabel(item.label, caption)}</span>
                      {item.id === value ? <span className="session-analyst__model-check" aria-hidden="true">✓</span> : null}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}

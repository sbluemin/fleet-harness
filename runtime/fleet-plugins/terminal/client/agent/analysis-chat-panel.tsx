import { React } from "@fleet-console/sdk/plugin/browser";
import { Select } from "@fleet-console/sdk/react/browser";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";

import type { AnalysisActivity, AnalysisEntry, AnalysisState } from "./analysis-state.js";
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
  const { state, dispatch, send, stop, reset } = useAnalysisStore(context);
  const language = context.language ?? "en";
  const t = getT(language);
  const reducedMotion = usePrefersReducedMotion();
  const [slashSelection, setSlashSelection] = React.useState(0);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  const hasInteracted = state.entries.length > 0;
  const artifactCount = state.artifacts.length;
  // 아티팩트는 드로어 안의 모드다 — 별도 컴패니언이 아니라 이 패널의 지역 상태가 화면을 가른다.
  const [mode, setMode] = React.useState<"chat" | "artifacts">("chat");
  const artifactAuthoring = state.artifactAuthoring !== null && artifactCount === 0;
  const previousArtifactCountRef = React.useRef(0);
  const [countPulseRevision, setCountPulseRevision] = React.useState(0);
  const artifactsChipRef = React.useRef<HTMLButtonElement>(null);
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
  const canReset = state.started || state.phase !== "idle" || state.draft.length > 0 || state.queue.length > 0 || state.entries.length > 0 || state.artifacts.length > 0;
  // 첫 상호작용이 이 마운트에서 발생했을 때만 도킹 모션을 붙인다. 클래스를 계속
  // 유지하면 뒤따르는 connected/chunk 렌더가 진행 중인 CSS 애니메이션을 끊지 않는다.
  const interactedAtMount = React.useRef(hasInteracted).current;
  const animateDock = hasInteracted && !interactedAtMount;
  React.useLayoutEffect(() => {
    const chat = chatRef.current;
    if (!chat || !hasInteracted) return;
    chat.scrollTop = chat.scrollHeight;
  }, [hasInteracted, latestEntry?.text, state.entries.length, state.latestActivity, state.phase, state.artifactAuthoring, state.artifactPublished, mode]);
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
  React.useEffect(() => {
    const previousCount = previousArtifactCountRef.current;
    previousArtifactCountRef.current = artifactCount;
    if (artifactCount === 0) {
      // 전량 삭제되면 볼 것이 없다 — 대화로 복귀하고, 포커스가 아티팩트 안이었다면 모드 칩으로 되돌린다.
      if (mode === "artifacts" && state.artifactAuthoring === null) {
        // 비우기는 아티팩트 화면 안에서 일어난다 — 그 서브트리가 사라지며 포커스가 body로
        // 떨어지고, 아티팩트 세그먼트도 비활성이 된다. 활성 세그먼트(Chat)로 되돌린다.
        setMode("chat");
        window.requestAnimationFrame(() => {
          artifactsChipRef.current?.closest(".session-analyst__modechip")
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
        });
      }
      return;
    }
    // 발행이 대화를 끌어내리지 않는다 — 인라인 발행 카드가 진입로, 배지 펄스가 신호를 진다.
    if (artifactCount > previousCount && mode === "chat") setCountPulseRevision((revision) => revision + 1);
  }, [artifactCount, mode, state.artifactAuthoring]);
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
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action="copy-code"]');
    if (!button) return;
    const code = button.closest("pre")?.getAttribute("data-code");
    if (!code) return;
    copyCodeToClipboard(button, code, language);
  }, [language]);

  const lastAnalystIndex = state.entries.reduce((last, entry, index) => entry.role === "analyst" ? index : last, -1);
  // 아직 분석가 chunk가 없는 진행/오류/중단은 합성 턴이 상태를 실어 나른다.
  const pendingTurn = state.phase !== "idle" && latestEntry?.role === "user"
    && (state.busy || state.phase === "error" || state.phase === "stopped");

  return (
    <section className={`session-analyst__chat-pane ${hasInteracted ? "has-interacted" : "is-initial"}`} aria-label={t("terminal.analyst.chatAria")} data-phase={state.phase}>
      <div className="session-analyst__chips">
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
            <button type="button" aria-pressed={mode === "chat"} onClick={() => setMode("chat")}>{t("terminal.analyst.mode.chat")}</button>
            <button
              ref={artifactsChipRef}
              type="button"
              className={artifactAuthoring ? "is-authoring" : undefined}
              aria-pressed={mode === "artifacts"}
              disabled={artifactCount === 0 && !artifactAuthoring}
              title={artifactAuthoring ? t("terminal.analyst.authoringTooltip") : artifactCount === 0 ? t("terminal.analyst.artifactsEmptyTooltip") : undefined}
              onClick={() => setMode("artifacts")}
            >
              {t("terminal.analyst.artifactsHandle")}
              {artifactCount > 0 ? <span key={countPulseRevision} className={`session-analyst__chip-count${countPulseRevision > 0 ? " is-pulsing" : ""}`}>{artifactCount}</span> : null}
              {artifactAuthoring ? <span className="session-analyst__chip-count">…</span> : null}
            </button>
          </span>
        </span>
      </div>
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
              onOpen={() => setMode("artifacts")}
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
        <form className={`session-analyst__composer ${hasInteracted ? "is-docked" : "is-initial"}${animateDock ? " is-docking" : ""}${state.busy ? " is-working" : ""}`} aria-busy={state.busy} onSubmit={(event) => { event.preventDefault(); void submit(state.draft, true); }}>
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
          {!hasInteracted ? <div className="session-analyst__selector-strip" aria-label={t("terminal.analyst.initialSettings")} onFocusCapture={() => setSlashDismissed(true)}>
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
            <span className="session-analyst__select">
              <Select
                compact
                label={t("terminal.analyst.model")}
                value={state.model}
                disabled={state.started || state.selectionLocked || !model}
                options={cli?.models.map((item) => ({ value: item.id, label: item.label })) ?? []}
                onChange={(nextModel) => dispatch({ type: "select-model", model: nextModel })}
              />
            </span>
            <span className="session-analyst__select">
              <Select
                compact
                label={t("terminal.analyst.effort")}
                value={state.effort}
                disabled={state.started || state.selectionLocked || !model || !model.effortLevels.length}
                options={model?.effortLevels.length ? model.effortLevels.map((item) => ({ value: item, label: item })) : [{ value: "", label: t("terminal.analyst.na") }]}
                onChange={(effort) => dispatch({ type: "select-effort", effort })}
              />
            </span>
            <span
              aria-live="polite"
              aria-atomic="true"
              style={{
                display: "inline-block",
                inlineSize: "5em",
                flex: "none",
                opacity: state.selectionSaved ? 1 : 0,
                textAlign: "center",
                transition: reducedMotion ? "none" : "opacity var(--duration-base) var(--ease-glide)",
              }}
            >{state.selectionSaved ? t("terminal.analyst.saved") : ""}</span>
          </div> : null}
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
            {state.busy ? (
              <button type="button" className="session-analyst__send session-analyst__stop" aria-label={t("terminal.analyst.stop")} onClick={() => void stop()}>
                <span aria-hidden="true" />
              </button>
            ) : null}
            <button type="submit" className="session-analyst__send" aria-label={t(state.busy ? "terminal.analyst.queueQuestion" : "terminal.analyst.send")} disabled={!state.draft.trim()}>
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
            </button>
          </div>
          {state.busy ? <div className="session-analyst__composer-hint">{t("terminal.analyst.queueHint")}</div> : null}
        </form>
      </div>
      )}
    </section>
  );
}

/* 분석가 턴 — 스파인 노드가 상태를, 헤드가 시간축을, 영수증이 과정을 말한다.
   entry=null이면 아직 chunk가 없는 진행/오류/중단의 합성 턴이다. 역사 턴은 봉인된
   entry.receipt만으로 그린다 — 전역 상태는 다음 send에서 이미 초기화됐다. */
function AnalystTurn({ state, language, entry, isLast, liveElapsedMs, decorateEvidence }: {
  readonly state: AnalysisState;
  readonly language: ConsoleLocale;
  readonly entry: AnalysisEntry | null;
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
  return (
    <li className={`session-analyst__message session-analyst__message--analyst${working ? " is-working" : ""}${isError ? " is-error" : ""}${!isError && isStopped ? " is-stopped" : ""}`}>
      <span className="session-analyst__turn-spine" aria-hidden="true"><span className="session-analyst__turn-node" /></span>
      <div className="session-analyst__turn-main">
        {working ? <div className="session-analyst__turn-head">{t("terminal.chat.turnWorking", { elapsed: formatElapsed(liveElapsedMs) })}</div> : null}
        {!working && receipt?.outcome === "complete" ? <div className="session-analyst__turn-head">{t("terminal.analyst.turnAnswered", { elapsed: formatElapsed(receipt.durationMs) })}</div> : null}
        {working || liveError ? <TurnPulse state={state} language={language} elapsedMs={liveElapsedMs} /> : null}
        {liveStopped ? <StoppedReceipt state={state} language={language} elapsedMs={liveElapsedMs} /> : null}
        {!liveStopped && !working && receipt?.outcome === "stopped" ? (
          <div className="session-analyst__stopped" role="status">{t("terminal.analyst.stoppedAt", { elapsed: formatElapsed(receipt.durationMs) })}</div>
        ) : null}
        {!liveError && !working && receipt?.outcome === "error" ? (
          <div className="session-analyst__stopped is-error" role="status">{`${receipt.error ? translateServerMessage(language, receipt.error) : t("terminal.analyst.state.needsAttention")} · ${formatElapsed(receipt.durationMs)}`}</div>
        ) : null}
        {!working && receipt?.outcome === "complete" ? <TurnReceipt language={language} durationMs={receipt.durationMs} tools={receipt.tools} /> : null}
        {entry !== null && entry.text !== "" ? (
          <div className="session-analyst__answer">
            <div className="session-analyst__answer-kicker" aria-hidden="true">{t("terminal.chat.answerLabel")}</div>
            <StreamedMarkdown className="session-analyst__response markdown-body" text={entry.text} streaming={working} language={language} transformHtml={decorateEvidence} />
          </div>
        ) : null}
      </div>
    </li>
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
          <strong key={`${state.phase}-${current.label}`}>{isError ? translateServerMessage(language, state.error ?? "") : current.label}</strong>
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

/* 완료 영수증 — 접힌 한 줄("✓ 12s · 3 steps"), 펼치면 이 턴이 밟은 도구 단계.
   값은 봉인된 턴 메타데이터에서 온다 — 전역 상태는 다음 턴에서 초기화된다. */
function TurnReceipt({ language, durationMs, tools }: { readonly language: ConsoleLocale; readonly durationMs: number; readonly tools: readonly { readonly title: string; readonly status: string }[] }) {
  const t = getT(language);
  const elapsed = formatElapsed(durationMs);
  const steps = tools;
  const stepsLabel = steps.length === 0 ? null : steps.length === 1 ? t("terminal.chat.oneStep") : t("terminal.chat.stepCount", { count: steps.length });
  const summary = stepsLabel ? `${elapsed} · ${stepsLabel}` : elapsed;
  return (
    <details className="session-analyst__receipt">
      <summary aria-label={t("terminal.chat.receiptAria")}>
        <span className="session-analyst__receipt-mark" aria-hidden="true">✓</span>
        {summary}
        <span className="session-analyst__receipt-chev" aria-hidden="true">❯</span>
      </summary>
      {steps.length > 0 ? (
        <div className="session-analyst__receipt-body">
          {steps.map((tool) => (
            <div className="session-analyst__receipt-step" key={tool.title}>
              <strong>{tool.title}</strong>
              <small>{tool.status}</small>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
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

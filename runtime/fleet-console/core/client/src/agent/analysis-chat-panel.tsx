import { analysisOriginLabel } from "./analysis-types.js";
import { React } from "@fleet-console/sdk/plugin/browser";

import { AgentGlyph } from "./agent-glyphs.js";
import { launchEtcGlyph, launchProviderCaption, launchProviderFromModelId, launchProviderGlyph } from "@fleet-console/sdk/components/launch-provider-glyphs";
import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { installDiagramHydrator } from "@fleet-console/markdown/mermaid";
import "@fleet-console/markdown/styles.css";

import { openPane } from "../pane/pane-store.js";
import { openRailPanel, setRailChromeExpanded } from "../rail/rail-store.js";
import { SETTINGS_PANE_ID, SETTINGS_RAIL_ENTRY_ID } from "../settings/settings-entry.js";
import { splitAnalystLedger, type AnalysisActivity, type AnalysisEntry, type AnalysisSegment, type AnalysisState, type AnalysisToolStep } from "./analysis-state.js";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { diagramHydratorLabels, getT, translateServerMessage, type TerminalMessageKey } from "./i18n/index.js";
import { decorateEvidenceHtml } from "./analysis-evidence.js";
import { useAnalysisStore } from "./analysis-store.js";
import { closeAnalystCompanionPanels } from "./analysis-visibility.js";
import { AnalystArtifactsPanel, ArtifactClearGlyph, ArtifactExportGlyph, ArtifactPicker } from "./analysis-artifacts-panel.js";
import { AnalystGlyphButton, useArmedAction } from "./analysis-glyph-button.js";
import type { AnalysisArtifact } from "./analysis-types.js";
import { StreamedMarkdown } from "./streamed-markdown.js";
import { HistoryBand, useHistoryReveal } from "@fleet-console/sdk/components/history-band";
import { LiveLine } from "@fleet-console/sdk/components/live-line";

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
  const [slashSelection, setSlashSelection] = React.useState(0);
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  const cli = state.catalog?.clis.find((item) => item.cliId === state.cliId);
  const model = cli?.models.find((item) => item.id === state.model);
  const modelProvider = launchProviderFromModelId(state.model);
  const modelCaption = modelProvider ? launchProviderCaption(modelProvider) : undefined;
  const openAnalystSettings = () => {
    openRailPanel(SETTINGS_RAIL_ENTRY_ID);
    openPane({ paneId: SETTINGS_PANE_ID, params: { section: "experiments" } });
    setRailChromeExpanded(true);
  };
  const hasInteracted = state.entries.length > 0;
  // 아티팩트는 드로어 안의 모드다 — 별도 컴패니언이 아니라 발판 줄의 글리프가 이 본문을 가른다.
  // 컴포저는 두 모드에 남는다: 아티팩트를 보면서도 이어 물을 수 있고, 발판 줄이 늘 같은 자리에 선다.
  const mode = state.viewMode;
  // 보고 있는 아티팩트 — 새 발행이 오면 그것으로 옮긴다. 발판 줄의 피커와 본문이 같은 값을 본다.
  const newestArtifactId = state.artifacts[0]?.id ?? null;
  const [activeArtifactId, setActiveArtifactId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (newestArtifactId) setActiveArtifactId(newestArtifactId);
  }, [newestArtifactId]);
  const activeArtifact: AnalysisArtifact | null = state.artifacts.find((artifact) => artifact.id === activeArtifactId) ?? state.artifacts[0] ?? null;
  const chatRef = React.useRef<HTMLElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const latestEntry = state.entries.at(-1);
  // 로그는 마지막 문답만 보여 준다 — 앞선 문답은 상단 밴드 뒤에 접히고, 누르거나 맨 위에서 위로
  // 한 번 더 굴리면 펼쳐진다. 새 질문이 서면 다시 접히고 그 질문이 로그 상단에 앉는다.
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const lastAskIndex = state.entries.reduce((found, entry, index) => entry.role === "user" ? index : found, -1);
  const earlierEntries = lastAskIndex > 0 ? state.entries.slice(0, lastAskIndex) : [];
  const currentEntries = lastAskIndex >= 0 ? state.entries.slice(lastAskIndex) : state.entries;
  const earlierCount = earlierEntries.filter((entry) => entry.role === "user").length;
  const askCount = earlierCount + (lastAskIndex >= 0 ? 1 : 0);
  const previousAskCountRef = React.useRef(askCount);
  const nearBottomRef = React.useRef(true);
  const revealHistory = React.useCallback(() => setHistoryOpen(true), []);
  useHistoryReveal({ ref: chatRef, armed: !historyOpen && earlierCount > 0, onReveal: revealHistory });
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
    const asked = askCount > previousAskCountRef.current;
    previousAskCountRef.current = askCount;
    if (asked) {
      // 새 질문 — 앞선 문답은 밴드 뒤로, 질문은 로그 상단으로. 답은 그 아래에서 자란다.
      setHistoryOpen(false);
      nearBottomRef.current = true;
      chat.scrollTop = 0;
      return;
    }
    // 답이 화면을 넘길 때만 바닥을 따른다 — 사용자가 위로 올려 읽는 중이면 따라가지 않는다.
    if (nearBottomRef.current) chat.scrollTop = chat.scrollHeight;
  }, [askCount, hasInteracted, state.entries, state.latestActivity, state.phase, state.artifactAuthoring, state.artifactPublished, mode]);
  const onChatScroll = React.useCallback(() => {
    const chat = chatRef.current;
    if (!chat || chat.clientHeight === 0) return;
    nearBottomRef.current = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  }, []);
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
  // 중단·전송은 한 묶음으로 레일 오른쪽 끝에 붙는다 — 각자 auto 마진을 쥐면 남는 폭이
  // 둘 사이에도 갈라져 중단 버튼이 레일 한가운데 떠 버린다(2026-09-01 실측).
  const actions = (
    <span className="session-analyst__actions">
      {state.busy ? (
        <button type="button" className="session-analyst__send session-analyst__stop" aria-label={t("terminal.analyst.stop")} onClick={() => void stop()}>
          <span aria-hidden="true" />
        </button>
      ) : null}
      <button type="submit" className="session-analyst__send" aria-label={t(state.busy ? "terminal.analyst.queueQuestion" : "terminal.analyst.send")} disabled={!state.draft.trim()}>
        <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 10 V2 M2.5 5.5 L6 2 l3.5 3.5" /></svg>
      </button>
    </span>
  );

  const lastAnalystIndex = state.entries.reduce((last, entry, index) => entry.role === "analyst" ? index : last, -1);
  // 아직 분석가 chunk가 없는 진행/오류/중단은 합성 턴이 상태를 실어 나른다.
  const pendingTurn = state.phase !== "idle" && latestEntry?.role === "user"
    && (state.busy || state.phase === "error" || state.phase === "stopped");

  return (
    <section className={`session-analyst__chat-pane ${hasInteracted ? "has-interacted" : "is-initial"}${mode === "artifacts" ? " is-artifacts" : ""}`} aria-label={t("terminal.analyst.chatAria")} data-phase={state.phase}>
      <div className="session-analyst__workspace">
        {mode === "artifacts" ? <AnalystArtifactsPanel context={context} artifact={activeArtifact} /> : (
        <section ref={chatRef} className="session-analyst__chat" aria-live="polite" aria-busy={state.busy} onScroll={onChatScroll}>
          {hasInteracted ? (
            <>
            <HistoryBand
              count={earlierCount}
              open={historyOpen}
              onToggle={() => setHistoryOpen((current) => !current)}
              label={t(historyOpen ? "terminal.chat.historyBandOpen" : "terminal.chat.historyBand", { count: earlierCount })}
            />
            <ol className="session-analyst__transcript" onClick={handleTranscriptClick}>
              {/* 앞선 문답은 표시만 거둔다 — 펼치면 문서 순서 그대로 위에 선다. */}
              <li className="session-analyst__history" hidden={!historyOpen}>
                <ol className="session-analyst__transcript">
                  {earlierEntries.map((entry, index) => entry.role === "user" ? (
                    <li className="session-analyst__message session-analyst__message--user" key={`user-${index}`}>
                      <span className="session-analyst__ask-meta">
                        <span className={`session-analyst__ask-who${entry.by ? " chat-by-agent" : ""}`}>{entry.by ? t("terminal.analyst.askedBy", { caller: analysisOriginLabel(entry.by) }) : t("terminal.analyst.you")}</span>
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
                      isLast={false}
                      liveElapsedMs={liveElapsedMs}
                      decorateEvidence={decorateEvidence}
                    />
                  ))}
                </ol>
              </li>
              {currentEntries.map((entry, offset) => {
                const index = Math.max(0, lastAskIndex) + offset;
                return entry.role === "user" ? (
                <li className="session-analyst__message session-analyst__message--user" key={`user-${index}`}>
                  <span className="session-analyst__ask-meta">
                    <span className={`session-analyst__ask-who${entry.by ? " chat-by-agent" : ""}`}>{entry.by ? t("terminal.analyst.askedBy", { caller: analysisOriginLabel(entry.by) }) : t("terminal.analyst.you")}</span>
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
              );
              })}
              {pendingTurn ? (
                <AnalystTurn state={state} language={language} entry={null} isLast liveElapsedMs={liveElapsedMs} decorateEvidence={decorateEvidence} />
              ) : null}
            </ol>
            </>
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
        )}
        {mode === "chat" && state.queue.length > 0 ? (
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
        {mode === "chat" && state.phase === "complete" && !state.busy && hasInteracted ? (
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
          {/* 발판 줄 — 상자 밖 한 줄. 왼쪽은 정체·상태와 모델(대화) 또는 보고 있는 아티팩트(아티팩트),
             오른쪽은 글자 없는 동작 글리프. 예전 캡션 밴드의 칩 줄이 여기로 내려왔다 — 캡션 띠를
             본문에 돌려주고, 컨트롤은 손이 이미 가 있는 입력 상자 바로 위에 선다. */}
          <AnalystFooting
            context={context}
            mode={mode}
            activeArtifact={activeArtifact}
            onSelectArtifact={setActiveArtifactId}
            focusComposer={() => window.requestAnimationFrame(() => textareaRef.current?.focus())}
            modelRow={(
              <button type="button" className="session-analyst__composer-model" title={t("terminal.analyst.modelFrom")} aria-label={t("terminal.analyst.changeInSettings")} onClick={openAnalystSettings}>
                <span className={`session-analyst__composer-model-mark operation-launch-provider-glyph${modelProvider ? ` is-${modelProvider}` : " operation-launch-provider-glyph--etc"}`} aria-hidden="true">
                  {modelProvider ? launchProviderGlyph(modelProvider) : launchEtcGlyph()}
                </span>
                <span className="session-analyst__composer-model-label">{model ? shortModelLabel(model.label, modelCaption) : state.model || "—"}</span>
                {state.effort ? <span className="session-analyst__composer-model-effort">{state.effort.toUpperCase()}</span> : null}
                {state.modelFallback ? <span className="session-analyst__composer-model-fallback">{t("terminal.analyst.modelFallback")}</span> : null}
                {state.started ? <span className="session-analyst__composer-model-pinned">{t("terminal.analyst.pinnedForSession")}</span> : null}
              </button>
            )}
          />
          {/* 한 줄 컴포저 — 「/」 입구 · 입력 · 동작(중단·전송)이 한 면 안에 앉는다. 입력이 자라도 입구와 동작은 아래 변에 남는다. */}
          <div className="session-analyst__composer-surface">
            <label className="session-analyst__sr-only" htmlFor={`analysis-${context.operationId}`}>{t("terminal.analyst.askAboutSession")}</label>
            <button
              type="button"
              className="session-analyst__slash-hint"
              aria-label={t("terminal.analyst.commands")}
              title={t("terminal.analyst.slashHint")}
              onClick={() => {
                dispatch({ type: "set-draft", draft: "/" });
                setSlashDismissed(false);
                setSlashSelection(0);
                window.requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            >/</button>
            <textarea
              ref={textareaRef}
              id={`analysis-${context.operationId}`}
              role="combobox"
              aria-expanded={slashOpen}
              aria-controls={slashListboxId}
              aria-activedescendant={activeSlashOption ? slashOptionId(activeSlashOption.command) : undefined}
              rows={1}
              placeholder={t(state.busy ? "terminal.analyst.queueHint" : "terminal.analyst.composerPlaceholder")}
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
                  } else if (mode === "artifacts") {
                    // 아티팩트를 보는 중이면 Esc는 먼저 대화로 돌아온다 — 발판 줄의 닫기 글리프와 같은 동작.
                    dispatch({ type: "view-mode", mode: "chat" });
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
            {actions}
          </div>
        </form>
        {/* 받침 — 채팅뷰 settle과 동형. 첫 질문 전에는 flex-grow 0.8로 초대·컴포저를 중앙에
           세우고, 스트리밍이 시작되면 0으로 줄며 컴포저가 하단에 내려앉는다(비율 전환이라
           어떤 패널 높이에서도 같은 자리). */}
        <div className="session-analyst__settle" aria-hidden="true" />
      </div>
    </section>
  );
}

/* 발판 줄 — 컴포저 바로 위 한 줄. 왼쪽은 정체·상태와 모델(대화) 또는 보고 있는 아티팩트(아티팩트),
   오른쪽은 글자 없는 동작 글리프: 대화에서는 [초기화][아티팩트·n], 아티팩트에서는
   [초기화][대화로 돌아가기] │ [내보내기][모두 지우기]. 예전 캡션 밴드의 칩 줄과 아티팩트 헤더가
   여기로 접혔다 — 캡션 띠(32px)와 헤더(44px)를 본문에 돌려주고, 컨트롤은 손이 이미 가 있는
   입력 상자 위에 선다. 글리프 문법은 부관단 머리 동작과 같다: 24px 버튼, 접근 이름이 곧
   말풍선 문장, 눌린 면은 brass(위치 채널). */
function AnalystFooting({ context, mode, activeArtifact, onSelectArtifact, focusComposer, modelRow }: {
  readonly context: OperationRenderContext;
  readonly mode: "chat" | "artifacts";
  readonly activeArtifact: AnalysisArtifact | null;
  readonly onSelectArtifact: (id: string) => void;
  readonly focusComposer: () => void;
  readonly modelRow: React.ReactNode;
}) {
  const { state, dispatch, reset } = useAnalysisStore(context);
  const language = context.language ?? "en";
  const t = getT(language);
  const artifactCount = state.artifacts.length;
  const artifactAuthoring = state.artifactAuthoring !== null && artifactCount === 0;
  const canReset = state.started || state.phase !== "idle" || state.draft.length > 0 || state.queue.length > 0 || state.entries.length > 0 || state.artifacts.length > 0;
  const previousArtifactCountRef = React.useRef(0);
  const [countPulseRevision, setCountPulseRevision] = React.useState(0);
  React.useEffect(() => {
    const previousCount = previousArtifactCountRef.current;
    previousArtifactCountRef.current = artifactCount;
    if (artifactCount === 0) {
      // 전량 삭제되면 볼 것이 없다 — 대화로 복귀하고, 포커스가 아티팩트 안이었다면 컴포저로 되돌린다
      // (컴포저는 두 모드에 남으므로 언제나 받을 자리가 있다).
      if (mode === "artifacts" && state.artifactAuthoring === null) {
        dispatch({ type: "view-mode", mode: "chat" });
        focusComposer();
      }
      return;
    }
    // 발행이 대화를 끌어내리지 않는다 — 인라인 발행 카드가 진입로, 배지 펄스가 신호를 진다.
    if (artifactCount > previousCount && mode === "chat") setCountPulseRevision((revision) => revision + 1);
  }, [artifactCount, dispatch, focusComposer, mode, state.artifactAuthoring]);
  // 초기화와 모두 지우기는 글자를 잃은 만큼 오클릭 비용이 올랐다 — 두 번 누름으로 지킨다:
  // 첫 누름은 무장(brass 면, 말풍선이 "한 번 더"로 바뀜), 1.5초 안의 두 번째 누름이 실행한다.
  const resetArm = useArmedAction(() => { void reset().catch(() => {}); });
  const artifactsLabel = artifactAuthoring
    ? t("terminal.analyst.authoringTooltip")
    : artifactCount === 0
      ? t("terminal.analyst.artifactsEmptyTooltip")
      : t(artifactCount === 1 ? "terminal.artifacts.showCount_one" : "terminal.artifacts.showCount_other", { count: artifactCount });
  return (
    <div className="session-analyst__footing" data-phase={state.phase}>
      <span className="session-analyst__footing-lead">
        {mode === "artifacts" ? (
          <ArtifactPicker context={context} active={activeArtifact} onSelect={onSelectArtifact} />
        ) : (
          <>
            <i className="session-analyst__chip-dot" aria-hidden="true" />
            <span className="session-analyst__chip-state">{stateLabel(state, language)}</span>
            {modelRow}
          </>
        )}
      </span>
      <span className="session-analyst__footing-actions">
        <AnalystGlyphButton
          label={resetArm.armed ? t("terminal.analyst.resetConfirm") : t("terminal.analyst.resetAria")}
          pressed={resetArm.armed}
          disabled={!canReset}
          onClick={resetArm.trigger}
        ><AgentGlyph name="reset" /></AnalystGlyphButton>
        {mode === "artifacts" ? (
          <>
            <AnalystGlyphButton label={t("terminal.analyst.backToChat")} onClick={() => { dispatch({ type: "view-mode", mode: "chat" }); focusComposer(); }}>
              <AgentGlyph name="close" />
            </AnalystGlyphButton>
            <i className="session-analyst__footing-sep" aria-hidden="true" />
            <ArtifactExportGlyph context={context} active={activeArtifact} />
            <ArtifactClearGlyph context={context} />
          </>
        ) : (
          <AnalystGlyphButton
            label={artifactsLabel}
            pressed={false}
            disabled={artifactCount === 0 && !artifactAuthoring}
            className={artifactAuthoring ? "is-authoring" : undefined}
            onClick={() => dispatch({ type: "view-mode", mode: "artifacts" })}
          >
            <AgentGlyph name="artifact" />
            {artifactCount > 0 ? <span key={countPulseRevision} className={`session-analyst__chip-count${countPulseRevision > 0 ? " is-pulsing" : ""}`}>{artifactCount}</span> : null}
            {artifactAuthoring ? <span className="session-analyst__chip-count">…</span> : null}
          </AnalystGlyphButton>
        )}
      </span>
    </div>
  );
}


/* 분석가 턴 — 채팅뷰 원장 문법: 시계·접힘 줄·결말 문구가 상태를, 구간(문장+스텝)이 과정을,
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
      <div className="session-analyst__turn-main">
        {/* 도는 동안의 시계는 채팅 원장과 같은 명도 물결을 진다 — 두 면이 같은 사실("이 턴이
            아직 살아 있다")을 말하므로 어휘가 갈리면 안 된다. */}
        {/* 도는 동안은 Live line 한 줄뿐이다 — 지금 하는 것과 경과·스텝 수가 제자리에서 갱신되고,
           과정 전체는 끝난 뒤 접힘을 펼쳐야 나온다(채팅뷰·코워크·부관과 같은 문법). */}
        {working ? (
          <LiveLine
            label={currentActivity(state.latestActivity, language).label}
            thinking={!state.latestActivity || state.latestActivity.kind === "starting" || state.latestActivity.kind === "reasoning"}
            meta={`${stepsLabel ? `${stepsLabel} · ` : ""}${formatElapsed(liveElapsedMs)}`}
          />
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
        {/* 펄스는 실패를 말할 때만 선다 — 진행은 위 Live line 하나가 말한다. */}
        {liveError ? <TurnPulse state={state} language={language} elapsedMs={liveElapsedMs} /> : null}
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

/* 구간 — 모델의 문장 하나와 그 문장으로 한 일. 문장은 공유 마크다운이, 스텝은 상태 글리프가 진다.
   stepsMode="none"은 라이브 원장 전용이다 — 도구는 턴 말미의 단일 행이 대신 말한다. */
function LedgerSegment({ segment, language, decorateEvidence, live, stepsMode = "all" }: {
  readonly segment: AnalysisSegment;
  readonly language: ConsoleLocale;
  readonly decorateEvidence: (html: string) => string;
  readonly live: boolean;
  readonly stepsMode?: "all" | "none";
}) {
  return (
    <div className="session-analyst__seg">
      {segment.text !== "" ? (
        <StreamedMarkdown className="session-analyst__seg-text markdown-body" text={segment.text} streaming={false} language={language} transformHtml={decorateEvidence} />
      ) : null}
      {stepsMode === "all" && segment.steps.length > 0 ? (
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
  const nextHeight = Math.max(30, Math.min(textarea.scrollHeight, maxHeight));
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
        <span className="session-analyst__author-sigil" aria-hidden="true"><AgentGlyph name="artifact" /></span>
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

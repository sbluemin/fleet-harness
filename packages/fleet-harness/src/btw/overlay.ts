import type { ExtensionContext, Theme } from "@sbluemin/fleet-coding-agent";
import { getMarkdownTheme } from "@sbluemin/fleet-coding-agent";
import type { Component, Focusable, TUI } from "@sbluemin/fleet-tui";
import { Markdown } from "@sbluemin/fleet-tui";
import { Key, matchesKey, visibleWidth } from "@sbluemin/fleet-tui";

import { admiral, type ProviderInfo, type SelectableThinkingLevel } from "@sbluemin/fleet-core";

interface BtwHistoryEntry {
  question: string;
  answer: string;
}

interface BtwModelInfo {
  id: string;
  name: string;
}

interface BtwSelection {
  provider: ProviderInfo;
  model: BtwModelInfo;
  effort: SelectableThinkingLevel;
}

interface BtwSelectionOption {
  providerIndex: number;
  modelIndex: number;
  provider: ProviderInfo;
  model: BtwModelInfo;
}

interface BtwToolCall {
  toolCallId: string;
  title: string;
  status: string;
}

interface BtwFrame {
  innerWidth: number;
  topBorder: string;
  bottomBorder: string;
  separator: string;
  emptyRow: () => string;
  row: (content: string) => string;
}

const MIN_EDITOR_CARD_WIDTH = 48;
const MAX_HISTORY_ENTRIES = 10;
const MAX_HISTORY_CHARS = 16_000;
const POOL_KEY = "fleet:btw:adhoc";
const CONTROL_INPUT_REGEX = /[\x00-\x1f\x7f-\x9f]/;
const STATUS_LABELS: Record<string, string> = {
  conn: "connecting",
  stream: "responding",
  done: "done",
  err: "error",
  aborted: "aborted",
};
const DROPDOWN_VIEWPORT_ROWS = 7;
const DROPDOWN_INDICATOR_ROWS = 1;
// 프레임 고정 라인 수: topBorder + title + separator + input + selection + separator + bottomBorder
const FIXED_FRAME_LINES = 7;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export class BtwOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly ctx: ExtensionContext;
  private readonly done: () => void;
  private readonly providers: ProviderInfo[];
  private readonly markdown: Markdown;

  private abortController: AbortController | null = null;
  private closed = false;
  private draft = "";
  private errorMessage: string | null = null;
  private history: BtwHistoryEntry[] = [];
  private isDropdownOpen = false;
  private outputBuffer = "";

  // 확정된 모델 선택
  private providerIndex = 0;
  private modelIndex = 0;
  private effortIndex = 0;

  // 드롭다운 탐색용 pending 상태
  private pendingProviderIndex = 0;
  private pendingModelIndex = 0;
  private pendingEffortIndex = 0;
  private pendingQuery = "";
  private pendingViewportStart = 0;

  private running = false;
  private spinnerIndex = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private statusLabel = "idle";
  private toolCalls: BtwToolCall[] = [];

  constructor(
    tui: TUI,
    theme: Theme,
    ctx: ExtensionContext,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.ctx = ctx;
    this.done = done;
    this.providers = admiral.agent.models.listProviders()
      .filter((provider) => admiral.agent.models.getCliModels(provider.cli).length > 0);
    this.markdown = new Markdown("", 0, 0, getMarkdownTheme());
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.isDropdownOpen) {
        if (this.pendingQuery.length > 0) {
          this.pendingQuery = "";
          this.pendingViewportStart = 0;
          this.syncPendingSelectionWithMatches(false);
          this.requestRender();
        } else {
          this.cancelDropdown();
        }
      } else {
        this.close();
      }
      return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.isDropdownOpen) {
        this.confirmDropdown();
      } else {
        void this.submitDraft();
      }
      return;
    }

    if (matchesKey(data, Key.ctrl("l"))) {
      if (!this.isDropdownOpen) {
        this.openDropdown();
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.isDropdownOpen) {
        this.movePendingModel(1);
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.isDropdownOpen) {
        this.movePendingModel(-1);
      }
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      if (this.isDropdownOpen) {
        this.jumpPendingModel(-DROPDOWN_VIEWPORT_ROWS);
      }
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      if (this.isDropdownOpen) {
        this.jumpPendingModel(DROPDOWN_VIEWPORT_ROWS);
      }
      return;
    }

    if (matchesKey(data, Key.home)) {
      if (this.isDropdownOpen) {
        this.jumpPendingModel("start");
      }
      return;
    }

    if (matchesKey(data, Key.end)) {
      if (this.isDropdownOpen) {
        this.jumpPendingModel("end");
      }
      return;
    }

    if (matchesKey(data, Key.left)) {
      if (this.isDropdownOpen) {
        this.movePendingEffort(-1);
      }
      return;
    }

    if (matchesKey(data, Key.right)) {
      if (this.isDropdownOpen) {
        this.movePendingEffort(1);
      }
      return;
    }

    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      if (this.isDropdownOpen) {
        if (this.pendingQuery.length > 0) {
          this.pendingQuery = this.pendingQuery.slice(0, -1);
          this.pendingViewportStart = 0;
          this.syncPendingSelectionWithMatches(false);
          this.requestRender();
        }
        return;
      }
      if (this.running || this.isDropdownOpen) return;
      this.draft = this.draft.slice(0, -1);
      this.errorMessage = null;
      this.requestRender();
      return;
    }

    if (!this.running && !this.isDropdownOpen && isPrintableTextInput(data)) {
      this.draft += data;
      this.errorMessage = null;
      this.requestRender();
      return;
    }

    if (this.isDropdownOpen && isPrintableTextInput(data)) {
      this.pendingQuery += data;
      this.pendingViewportStart = 0;
      this.syncPendingSelectionWithMatches(true);
      this.requestRender();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const frame = createFrame(this.theme, resolveEditorCardWidth(width));
    const dim = (s: string) => this.theme.fg("dim", s);
    const accent = (s: string) => this.theme.fg("accent", s);
    const warning = (s: string) => this.theme.fg("warning", s);
    const selection = this.getSelection();
    const lines: string[] = [];

    lines.push(frame.topBorder);

    if (this.isDropdownOpen) {
      lines.push(frame.row(`${accent("/btw")} ${dim("타이핑 검색 · Backspace 지움 · ↑↓/PgUp/PgDn/Home/End 탐색 · Enter 확정 · Esc 취소 · ←→ 추론 강도")}`));
    } else {
      lines.push(frame.row(`${accent("/btw")} ${dim("Ctrl+L 모델 선택 · Enter 전송 · Esc 닫기")}`));
    }

    lines.push(frame.separator);

    if (!selection) {
      lines.push(frame.emptyRow());
      lines.push(frame.row(warning("사용 가능한 Fleet provider/model이 없습니다.")));
      lines.push(frame.row(dim("모델 카탈로그가 준비된 뒤 다시 실행하세요.")));
      lines.push(frame.emptyRow());
      lines.push(frame.bottomBorder);
      return lines;
    }

    lines.push(frame.row(this.truncateToWidth(`> ${this.draft}${this.running ? "" : "▌"}`, frame.innerWidth)));
    lines.push(frame.row(dim(this.buildSelectionLabel(selection))));

    if (this.isDropdownOpen) {
      for (const row of this.buildDropdownRows()) {
        lines.push(frame.row(row));
      }
    }

    lines.push(frame.separator);

    // 도구 호출 표시 (Pi 도구 실행 색상 스키마 적용)
    for (const toolCall of this.toolCalls) {
      const isPending = toolCall.status !== "completed" && toolCall.status !== "error";
      const spinner = isPending ? this.theme.fg("accent", this.currentSpinner()) : "";
      const statusIcon = toolCall.status === "completed"
        ? this.theme.fg("success", "✓")
        : toolCall.status === "error"
          ? this.theme.fg("error", "✗")
          : "";
      const toolTitle = this.theme.fg("toolTitle", this.theme.bold(toolCall.title));
      const statusText = this.theme.fg("muted", `(${toolCall.status})`);
      lines.push(frame.row(`${spinner}${statusIcon} ${toolTitle} ${statusText}`));
    }

    // 터미널 높이에서 고정 라인 + 드롭다운 + 도구 호출을 제외한 나머지를 출력 영역으로 할당
    const terminalRows = this.tui.terminal.rows;
    const dropdownLines = this.isDropdownOpen ? this.getDropdownLineCount() : 0;
    const usedLines = FIXED_FRAME_LINES + dropdownLines + this.toolCalls.length + (this.errorMessage ? 1 : 0);
    const maxOutputLines = Math.max(3, terminalRows - usedLines);

    const outputLines = this.buildOutputLines(frame.innerWidth, maxOutputLines);
    if (outputLines.length === 0) {
      const statusSpinner = this.running ? `${this.theme.fg("accent", this.currentSpinner())} ${this.theme.fg("muted", `${this.statusLabel}...`)}` : dim("AI output will appear here.");
      lines.push(frame.row(statusSpinner));
    } else {
      for (const outputLine of outputLines) {
        lines.push(frame.row(outputLine));
      }
    }

    if (this.errorMessage) {
      lines.push(frame.row(warning(this.errorMessage)));
    }

    lines.push(frame.bottomBorder);
    return lines;
  }

  private async submitDraft(): Promise<void> {
    const question = this.draft.trim();
    const selection = this.getSelection();

    if (!question || this.running || !selection) return;

    const request = this.buildRequest(question);
    const controller = new AbortController();
    this.abortController = controller;
    this.draft = "";
    this.errorMessage = null;
    this.outputBuffer = "";
    this.toolCalls = [];
    this.running = true;
    this.statusLabel = "connecting";
    this.startSpinner();
    this.requestRender();

    try {
      const result = await admiral.agent.executor.executeOneShot({
        poolKey: POOL_KEY,
        cliType: selection.provider.cli,
        request,
        cwd: this.resolveCwd(),
        model: selection.model.id,
        effort: selection.effort === "off" ? undefined : selection.effort,
        signal: controller.signal,
        onMessageChunk: (text) => {
          if (this.closed) return;
          this.outputBuffer += text;
          this.requestRender();
        },
        onToolCall: (title, status, _rawOutput, toolCallId) => {
          if (this.closed) return;
          const id = toolCallId ?? `${title}:${this.toolCalls.length}`;
          const existing = this.toolCalls.find((tc) => tc.toolCallId === id);
          if (existing) {
            existing.status = status;
          } else {
            this.toolCalls.push({ toolCallId: id, title, status });
          }
          this.requestRender();
        },
        onThoughtChunk: () => {
          if (this.closed) return;
          this.requestRender();
        },
        onStatusChange: (status) => {
          if (this.closed) return;
          this.statusLabel = STATUS_LABELS[status] ?? status;
          this.requestRender();
        },
      });

      if (this.closed) return;

      const answer = (result.responseText || this.outputBuffer).trim();
      if (result.status === "done" && answer) {
        this.history.push({ question, answer });
        this.trimHistory();
        this.outputBuffer = answer;
        this.statusLabel = "done";
      } else if (result.status === "aborted") {
        this.statusLabel = "aborted";
      } else {
        this.errorMessage = result.error ?? "응답을 완료하지 못했습니다.";
        this.statusLabel = STATUS_LABELS[result.status] ?? "error";
      }
    } catch (error) {
      if (!this.closed) {
        this.errorMessage = error instanceof Error ? error.message : String(error);
        this.statusLabel = "error";
      }
    } finally {
      if (!this.closed) {
        this.running = false;
        this.stopSpinner();
        this.abortController = null;
        this.requestRender();
      }
    }
  }

  private close(): void {
    this.closed = true;
    this.stopSpinner();
    this.abortController?.abort();
    this.abortController = null;
    this.done();
  }

  private startSpinner(): void {
    this.stopSpinner();
    this.spinnerIndex = 0;
    this.spinnerInterval = setInterval(() => {
      if (this.closed) { this.stopSpinner(); return; }
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      this.requestRender();
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  private currentSpinner(): string {
    return SPINNER_FRAMES[this.spinnerIndex] ?? SPINNER_FRAMES[0]!;
  }

  // ── 드롭다운: pending 탐색 → Enter 확정 / Esc 취소 ──

  private openDropdown(): void {
    if (this.running || this.providers.length === 0) return;
    this.pendingProviderIndex = this.providerIndex;
    this.pendingModelIndex = this.modelIndex;
    this.pendingEffortIndex = this.effortIndex;
    this.pendingQuery = "";
    this.pendingViewportStart = 0;
    this.syncPendingViewport();
    this.isDropdownOpen = true;
    this.requestRender();
  }

  private confirmDropdown(): void {
    if (this.buildSelectionOptions().length === 0) {
      this.isDropdownOpen = false;
      this.pendingQuery = "";
      this.pendingViewportStart = 0;
      this.requestRender();
      return;
    }

    this.providerIndex = this.pendingProviderIndex;
    this.modelIndex = this.pendingModelIndex;
    this.effortIndex = this.pendingEffortIndex;
    this.isDropdownOpen = false;
    this.pendingQuery = "";
    this.pendingViewportStart = 0;
    this.requestRender();
  }

  private cancelDropdown(): void {
    this.isDropdownOpen = false;
    this.pendingQuery = "";
    this.pendingViewportStart = 0;
    this.requestRender();
  }

  private movePendingModel(delta: number): void {
    const options = this.buildSelectionOptions();
    if (options.length === 0) return;

    const currentIndex = this.findPendingOptionIndex(options);
    const nextIndex = wrapIndex((currentIndex < 0 ? 0 : currentIndex) + delta, options.length);
    const nextOption = options[nextIndex]!;

    this.pendingProviderIndex = nextOption.providerIndex;
    this.pendingModelIndex = nextOption.modelIndex;
    this.pendingEffortIndex = 0;
    if (currentIndex === options.length - 1 && nextIndex === 0) {
      this.pendingViewportStart = 0;
    } else {
      this.syncPendingViewport(nextIndex, options.length);
    }
    this.requestRender();
  }

  private jumpPendingModel(target: number | "start" | "end"): void {
    const options = this.buildSelectionOptions();
    if (options.length === 0) return;

    const currentIndex = Math.max(0, this.findPendingOptionIndex(options));
    const nextIndex = target === "start" ? 0
      : target === "end" ? options.length - 1
        : clamp(currentIndex + target, 0, options.length - 1);
    const nextOption = options[nextIndex]!;

    this.pendingProviderIndex = nextOption.providerIndex;
    this.pendingModelIndex = nextOption.modelIndex;
    this.pendingEffortIndex = 0;
    this.syncPendingViewport(nextIndex, options.length);
    this.requestRender();
  }

  private movePendingEffort(delta: number): void {
    const provider = this.providers[this.pendingProviderIndex];
    if (!provider) return;

    const models = admiral.agent.models.getCliModels(provider.cli);
    const model = models[this.pendingModelIndex] ?? models[0];
    if (!model) return;

    const efforts = admiral.agent.models.getSelectableThinkingLevels(provider.cli, model.id) ?? ["off"];
    if (efforts.length <= 1) return;

    this.pendingEffortIndex = wrapIndex(this.pendingEffortIndex + delta, efforts.length);
    this.requestRender();
  }

  // ── 선택 조회 (확정된 값 기준) ──

  private getSelection(): BtwSelection | null {
    const provider = this.providers[this.providerIndex];
    if (!provider) return null;

    const models = admiral.agent.models.getCliModels(provider.cli);
    const model = models[this.modelIndex] ?? models[0];
    if (!model) return null;

    const efforts = admiral.agent.models.getSelectableThinkingLevels(provider.cli, model.id) ?? ["off"];
    const effort = efforts[this.effortIndex] ?? efforts[0] ?? "off";

    return { provider, model, effort };
  }

  // ── 렌더링 헬퍼 ──

  private buildDropdownRows(): string[] {
    const dim = (s: string) => this.theme.fg("dim", s);
    const query = this.pendingQuery.length > 0 ? this.pendingQuery : dim("검색…");
    const options = this.buildSelectionOptions();
    const selectedIndex = Math.max(0, this.findPendingOptionIndex(options));
    this.syncPendingViewport(selectedIndex, options.length);
    const start = this.pendingViewportStart;
    const visibleOptions = options.slice(start, start + DROPDOWN_VIEWPORT_ROWS);

    const rows = [`  🔎 ${query}${this.pendingQuery.length > 0 ? "▌" : ""}`];

    if (options.length === 0) {
      rows.push(dim("  (no matches)"));
      return rows;
    }

    rows.push(...visibleOptions.map((option) => {
      const isPending =
        option.providerIndex === this.pendingProviderIndex &&
        option.modelIndex === this.pendingModelIndex;
      const marker = isPending ? "▸" : " ";

      // pending effort 표시
      let effortLabel = "";
      const efforts = admiral.agent.models.getSelectableThinkingLevels(option.provider.cli, option.model.id) ?? ["off"];
      if (isPending && efforts.length > 1) {
        const pendingEffort = efforts[this.pendingEffortIndex] ?? efforts[0];
        effortLabel = dim(` [${pendingEffort === "off" ? "effort off" : pendingEffort}]`);
      }

      const row = `  ${marker} ${option.provider.displayName} · ${option.model.name} ${dim(option.model.id)}${effortLabel}`;
      return isPending ? this.theme.bg("toolPendingBg", this.truncateToWidth(row, 80)) : this.truncateToWidth(row, 80);
    }));

    if (options.length > DROPDOWN_VIEWPORT_ROWS) {
      const hasAbove = start > 0;
      const hasBelow = start + DROPDOWN_VIEWPORT_ROWS < options.length;
      const icon = hasAbove && hasBelow ? "↕" : hasAbove ? "↑" : "↓";
      rows.push(dim(`  ${icon} (${selectedIndex + 1}/${options.length})`));
    }

    return rows;
  }

  private getDropdownLineCount(): number {
    const optionCount = this.buildSelectionOptions().length;
    return 1 + (optionCount === 0 ? 1 : Math.min(optionCount, DROPDOWN_VIEWPORT_ROWS) + (optionCount > DROPDOWN_VIEWPORT_ROWS ? DROPDOWN_INDICATOR_ROWS : 0));
  }

  private buildOutputLines(innerWidth: number, maxLines: number): string[] {
    const text = this.outputBuffer.trim();
    if (!text) return [];

    this.markdown.setText(text);
    return this.markdown.render(innerWidth).slice(-maxLines);
  }

  private buildRequest(question: string): string {
    const currentTurn = `User: ${question}`;
    const historyBudget = Math.max(0, MAX_HISTORY_CHARS - currentTurn.length - 2);
    const historyBlocks: string[] = [];
    let usedChars = 0;

    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const entry = this.history[index]!;
      const block = [
        `Previous turn ${index + 1}`,
        `User: ${entry.question}`,
        `Assistant: ${entry.answer}`,
      ].join("\n");
      const separatorChars = historyBlocks.length > 0 ? 2 : 0;
      const nextChars = usedChars + separatorChars + block.length;
      if (nextChars > historyBudget) break;
      historyBlocks.unshift(block);
      usedChars = nextChars;
    }

    return [historyBlocks.join("\n\n"), currentTurn]
      .filter(Boolean)
      .join("\n\n");
  }

  private buildSelectionLabel(selection: BtwSelection): string {
    const effortLabel = selection.effort === "off" ? "effort off" : `effort ${selection.effort}`;
    return `${selection.provider.displayName} (${selection.provider.cli}) · ${selection.model.name} · ${effortLabel}`;
  }

  private buildSelectionOptions(): BtwSelectionOption[] {
    const query = this.pendingQuery.toLowerCase();
    const options = this.providers.flatMap((provider, providerIndex) =>
      admiral.agent.models.getCliModels(provider.cli).map((model, modelIndex) => ({
        providerIndex,
        modelIndex,
        provider,
        model,
      })),
    );
    if (query.length === 0) return options;

    return options.filter((option) =>
      option.provider.displayName.toLowerCase().includes(query) ||
      option.model.name.toLowerCase().includes(query) ||
      option.model.id.toLowerCase().includes(query),
    );
  }

  private syncPendingSelectionWithMatches(resetToFirst: boolean): void {
    const options = this.buildSelectionOptions();
    const firstOption = options[0];
    if (!firstOption) return;

    const currentIndex = this.findPendingOptionIndex(options);
    if (resetToFirst || currentIndex < 0) {
      this.pendingProviderIndex = firstOption.providerIndex;
      this.pendingModelIndex = firstOption.modelIndex;
      this.pendingEffortIndex = 0;
      return;
    }

    this.syncPendingViewport(currentIndex, options.length);
  }

  private findPendingOptionIndex(options: BtwSelectionOption[]): number {
    return options.findIndex(
      (option) => option.providerIndex === this.pendingProviderIndex && option.modelIndex === this.pendingModelIndex,
    );
  }

  private syncPendingViewport(selectedIndex?: number, optionCount?: number): void {
    const options = optionCount === undefined ? this.buildSelectionOptions() : [];
    const count = optionCount ?? options.length;
    const selected = selectedIndex ?? this.findPendingOptionIndex(options);

    if (count <= DROPDOWN_VIEWPORT_ROWS || selected < 0) {
      this.pendingViewportStart = 0;
    } else if (selected < this.pendingViewportStart) {
      this.pendingViewportStart = selected;
    } else if (selected >= this.pendingViewportStart + DROPDOWN_VIEWPORT_ROWS) {
      this.pendingViewportStart = selected - DROPDOWN_VIEWPORT_ROWS + 1;
    }
    this.pendingViewportStart = clamp(this.pendingViewportStart, 0, Math.max(0, count - DROPDOWN_VIEWPORT_ROWS));
  }

  private resolveCwd(): string {
    const ctxWithCwd = this.ctx as ExtensionContext & { cwd?: string };
    return ctxWithCwd.cwd ?? process.cwd();
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private trimHistory(): void {
    while (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.shift();
    }

    while (this.serializeHistoryLength() > MAX_HISTORY_CHARS && this.history.length > 1) {
      this.history.shift();
    }
  }

  private serializeHistoryLength(): number {
    return this.history.reduce(
      (total, entry) => total + entry.question.length + entry.answer.length,
      0,
    );
  }

  private truncateToWidth(content: string, width: number): string {
    return truncateToWidth(content, width);
  }
}

function createFrame(theme: Theme, width: number): BtwFrame {
  const border = (s: string) => theme.fg("border", s);
  const innerWidth = Math.max(1, width - 4);
  const row = (content: string) => {
    const truncated = truncateToWidth(content, innerWidth);
    const pad = Math.max(0, innerWidth - visibleWidth(stripAnsi(truncated)));
    return border("│ ") + truncated + " ".repeat(pad) + border(" │");
  };

  return {
    innerWidth,
    topBorder: border(`╭${"─".repeat(innerWidth + 2)}╮`),
    bottomBorder: border(`╰${"─".repeat(innerWidth + 2)}╯`),
    separator: border(`├${"─".repeat(innerWidth + 2)}┤`),
    emptyRow: () => row(""),
    row,
  };
}

function resolveEditorCardWidth(width: number): number {
  return Math.max(MIN_EDITOR_CARD_WIDTH, width);
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateToWidth(content: string, width: number): string {
  if (visibleWidth(stripAnsi(content)) <= width) return content;
  let result = "";

  for (const char of content) {
    if (visibleWidth(stripAnsi(`${result}${char}`)) > Math.max(0, width - 1)) {
      return `${result}…`;
    }
    result += char;
  }

  return result;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isPrintableTextInput(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && !CONTROL_INPUT_REGEX.test(data);
}

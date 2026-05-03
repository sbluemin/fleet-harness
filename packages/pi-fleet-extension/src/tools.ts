import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { CliType } from "@sbluemin/unified-agent";
import {
  REQUEST_DIRECTIVE_MANIFEST,
  RequestDirectiveParams,
  type DirectiveAnswer,
  type DirectiveOption,
  type DirectiveQuestion,
  type DirectiveResult,
  type RenderOption,
  clampHeader,
  errorResult,
  hasPreview,
  validateQuestions,
} from "@sbluemin/fleet-core/admiral";
import type { CarrierConfig, CarrierMetadata } from "@sbluemin/fleet-core/admiral/carrier";
import * as carrierCore from "@sbluemin/fleet-core/admiral/carrier";

import type { BackendProgress, TaskForceResult, TaskForceState } from "@sbluemin/fleet-core/admiral/taskforce";
import type { SubtaskProgress, SquadronResult, SquadronState } from "@sbluemin/fleet-core/admiral/squadron";
import { SQUADRON_MAX_INSTANCES } from "@sbluemin/fleet-core/admiral/squadron";
import { getLogAPI } from "@sbluemin/fleet-core/services/log";
import {
  deriveToolDescription,
  registerToolPromptManifest,
} from "@sbluemin/fleet-core/services/tool-registry";
import {
  ANSI_RESET,
  CARRIER_BG_COLORS,
  CARRIER_COLORS,
  CLI_DISPLAY_NAMES,
  PANEL_DIM_COLOR,
  SORTIE_SUMMARY_COLOR,
  SQUADRON_BADGE_COLOR,
  TASKFORCE_BADGE_COLOR,
} from "@sbluemin/fleet-core/constants";
import type {
  AgentToolCtx,
  AgentToolSpec,
} from "@sbluemin/fleet-core";

import { syncModelConfig } from "./panel/config.js";
import { renderCarrierJobsCall, renderCarrierJobsResult, type CarrierJobsToolResult } from "./jobs.js";
import { getFleetRuntime } from "./fleet.js";
import {
  createDefaultResponseRenderer,
  createDefaultUserRenderer,
} from "./panel/message-render.js";

export type { BackendProgress, CarrierConfig, SquadronResult, SquadronState, SubtaskProgress, TaskForceResult, TaskForceState };
export { SQUADRON_MAX_INSTANCES };
export * from "@sbluemin/fleet-core/admiral/carrier";

interface PiRenderContext {
  readonly args?: unknown;
  readonly lastComponent?: unknown;
}

interface RenderEntry {
  label: string;
  text: string;
}

export interface SingleCarrierOptions {
  /** 정렬 및 표시용 슬롯 번호 */
  slot: number;
  /** carrierId 오버라이드 (미지정 시 cliType 사용) */
  id?: string;
  /** carrier 표시 이름 오버라이드 (미지정 시 CLI 표시 이름 사용) */
  displayName?: string;
  /** 전경색 오버라이드 (미지정 시 cliType 시그니처 색상 사용) */
  color?: string;
  /** 배경색 오버라이드 (미지정 시 cliType 시그니처 색상 사용) */
  bgColor?: string;
}

const COLLAPSED_MAX_LINES = 5;
const PREFIX = "╎";
const DIM = "\x1b[2m";

let shipyardLogCategoriesRegistered = false;

export function registerToolRegistry(ctx: ExtensionAPI, fleetEnabled: boolean): void {
  if (fleetEnabled) {
    registerFleetPiTools(ctx);
    carrierCore.onStatusUpdate(() => {
      syncModelConfig();
    });
  }
}

export function registerFleetPiTools(pi: ExtensionAPI): void {
  const specs = (getFleetRuntime().fleet as unknown as { readonly tools: readonly AgentToolSpec[] }).tools;

  for (const spec of specs) {
    pi.registerTool(toPiToolConfig(spec) as any);
  }
}

export function registerRequestDirective(pi: ExtensionAPI): void {
  registerToolPromptManifest(REQUEST_DIRECTIVE_MANIFEST);

  pi.registerTool({
    name: "request_directive",
    label: "Request Directive",
    description: deriveToolDescription(REQUEST_DIRECTIVE_MANIFEST),
    parameters: RequestDirectiveParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return errorResult("Error: UI 미지원 (비대화형 모드에서 실행 중)");
      }
      if (params.questions.length === 0) {
        return errorResult("Error: 질문이 제공되지 않았습니다");
      }

      const questions: DirectiveQuestion[] = params.questions.map((q: DirectiveQuestion) => ({
        ...q,
        header: clampHeader(q.header),
        multiSelect: q.multiSelect === true,
      }));
      const validationError = validateQuestions(questions);
      if (validationError) {
        return errorResult(validationError, questions);
      }

      const result = await requestDirectiveWithUi(ctx, questions);

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "대원수(Admiral of the Navy)가 지시 요청을 취소했습니다." }],
          details: result,
        };
      }

      const answerLines = result.answers.map((a) => {
        if (a.wasCustom) {
          return `${a.header}: Admiral of the Navy (대원수)'s directive: ${a.values[0]}`;
        }
        const valStr = a.values.join(", ");
        return `${a.header}: Admiral of the Navy (대원수) selected: ${valStr}`;
      });

      return {
        content: [{ type: "text", text: answerLines.join("\n") }],
        details: result,
      };
    },

    renderCall(args: { questions: DirectiveQuestion[] }, theme: any) {
      const qs = (args.questions as DirectiveQuestion[]) || [];
      const count = qs.length;
      const headers = qs.map((q) => q.header || "?").join(", ");
      let text = theme.fg("toolTitle", theme.bold("Request Directive "));
      text += theme.fg("muted", `${count}개 질문`);
      if (headers) {
        text += theme.fg("dim", ` (${truncateToWidth(headers, 40)})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, _options: { expanded: boolean; isPartial: boolean }, theme: any) {
      const details = result.details as DirectiveResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "⚓ Directive cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        const valStr = a.values.join(", ");
        if (a.wasCustom) {
          return `${theme.fg("success", "⚓ ")}${theme.fg("accent", a.header)}: ${theme.fg("muted", "(직접 작성) ")}${valStr}`;
        }
        return `${theme.fg("success", "⚓ ")}${theme.fg("accent", a.header)}: ${valStr}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

export function registerCarrier(pi: ExtensionAPI, config: CarrierConfig): void {
  carrierCore.registerCarrier(config);

  const userRenderer = config.renderUser ?? createDefaultUserRenderer(config);
  pi.registerMessageRenderer(`${config.id}-user`, userRenderer);

  const responseRenderer = config.renderResponse ?? createDefaultResponseRenderer(config);
  pi.registerMessageRenderer(`${config.id}-response`, responseRenderer);
}

export function registerSingleCarrier(
  pi: ExtensionAPI,
  cli: CliType,
  metadata: CarrierMetadata,
  options: SingleCarrierOptions,
): void {
  const carrierId = options.id ?? cli;
  const displayName = options.displayName ?? CLI_DISPLAY_NAMES[cli] ?? cli;
  const config: CarrierConfig = {
    id: carrierId,
    cliType: cli,
    defaultCliType: cli,
    slot: options.slot,
    displayName,
    color: options.color ?? CARRIER_COLORS[cli] ?? "",
    bgColor: options.bgColor ?? CARRIER_BG_COLORS[cli],
    carrierMetadata: metadata,
  };
  registerCarrier(pi, config);

  carrierCore.reorderRegisteredByCliType();
}

export function ensureShipyardLogCategories(): void {
  if (shipyardLogCategoriesRegistered) {
    return;
  }
  shipyardLogCategoriesRegistered = true;
  getLogAPI().registerCategory({
    id: "prompt",
    label: "Carrier Prompt",
    description: "캐리어 프롬프트 전문 로그",
  });
}

function toPiToolConfig(spec: AgentToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
    parameters: spec.parameters,
    renderCall(args: unknown, theme: Theme, context: PiRenderContext) {
      return renderToolCall(spec, args, theme, context);
    },
    renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: PiRenderContext) {
      return renderToolResult(spec, result, options, theme, context);
    },
    execute(id: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const runtime = getFleetRuntime();
      const admiral = runtime.fleet as unknown as { readonly admiral: { tools: { invoke(name: string, args: unknown, ctx?: { cwd?: string; toolCallId?: string; signal?: AbortSignal | undefined }): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> } } };
      return admiral.admiral.tools.invoke(spec.name, params, { cwd: ctx.cwd, toolCallId: id, signal });
    },
  } as any;
}

function buildAgentToolCtx(toolCallId: string, signal: AbortSignal | undefined, ctx: ExtensionContext): AgentToolCtx {
  return {
    cwd: ctx.cwd,
    toolCallId,
    signal,
  };
}


function renderToolCall(spec: AgentToolSpec, args: unknown, _theme: Theme, context: PiRenderContext): unknown {
  if (spec.name === "carrier_jobs") {
    return renderCarrierJobsCall(args, context);
  }
  if (spec.name === "carrier_squadron") {
    const rendered = spec.render?.call?.(args, buildAgentToolCtx("", undefined, { cwd: "" } as ExtensionContext)) as { carrier: string; count: number };
    return oneLine(`  ⚓ ${SQUADRON_BADGE_COLOR}Squadron${ANSI_RESET}: ${SQUADRON_BADGE_COLOR}${rendered.carrier} ×${rendered.count} subtasks${ANSI_RESET}`);
  }
  if (spec.name === "carrier_taskforce") {
    const carrier = spec.render?.call?.(args, buildAgentToolCtx("", undefined, { cwd: "" } as ExtensionContext)) as string;
    return oneLine(`  ⚓ ${TASKFORCE_BADGE_COLOR}Taskforce${ANSI_RESET}: ${TASKFORCE_BADGE_COLOR}${carrier}${ANSI_RESET}`);
  }
  if (spec.name.startsWith("carrier_") && spec.name !== "carrier_jobs" && spec.name !== "carrier_squadron" && spec.name !== "carrier_taskforce") {
    // 개별 캐리어 도구 렌더링
    const carrierId = spec.name.replace("carrier_", "");
    const carrierColor = CARRIER_COLORS[carrierId] ?? SORTIE_SUMMARY_COLOR;
    const carrierName = CLI_DISPLAY_NAMES[carrierId] ?? carrierId;
    return oneLine(`  ⚓ ${carrierColor}${carrierName}${ANSI_RESET}`);
  }
  return undefined;
}

function renderToolResult(
  spec: AgentToolSpec,
  result: unknown,
  options: { expanded: boolean; isPartial: boolean },
  _theme: Theme,
  context: PiRenderContext,
): unknown {
  if (spec.name === "carrier_jobs") {
    return renderCarrierJobsResult(result as CarrierJobsToolResult);
  }
  const entries = buildPreviewEntries(spec.name, context.args);
  const color = spec.name === "carrier_squadron"
    ? SQUADRON_BADGE_COLOR
    : spec.name === "carrier_taskforce"
      ? TASKFORCE_BADGE_COLOR
      : resolveToolCarrierColor(spec.name);
  return {
    render(width: number) {
      return renderRequestPreview(entries, options.expanded, color, width);
    },
    invalidate() {},
  };
}

function oneLine(line: string): { render(): string[]; invalidate(): void } {
  return {
    render() { return [line]; },
    invalidate() {},
  };
}

function buildPreviewEntries(toolName: string, args: unknown): RenderEntry[] {
  if (!isRecord(args)) return [];

  // 개별 캐리어 도구: 파라미터 구조 { request: string }
  const isIndividualCarrierTool = toolName.startsWith("carrier_")
    && toolName !== "carrier_jobs"
    && toolName !== "carrier_squadron"
    && toolName !== "carrier_taskforce";
  if (isIndividualCarrierTool && typeof args.request === "string") {
    const carrierId = toolName.replace("carrier_", "");
    const carrierName = CLI_DISPLAY_NAMES[carrierId] ?? carrierId;
    return [{ label: carrierName, text: String(args.request ?? "") }];
  }

  if (toolName === "carrier_squadron" && Array.isArray(args.subtasks)) {
    return args.subtasks
      .filter(isRecord)
      .map((subtask) => ({ label: `"${String(subtask.title ?? "")}"`, text: String(subtask.request ?? "") }));
  }

  if (toolName === "carrier_taskforce" && typeof args.request === "string") {
    return [{ label: "", text: args.request }];
  }

  return [];
}

/** 개별 캐리어 도구의 캐리어 ID에서 색상을 해석 */
function resolveToolCarrierColor(toolName: string): string {
  const carrierId = toolName.replace("carrier_", "");
  return CARRIER_COLORS[carrierId] ?? SORTIE_SUMMARY_COLOR;
}

function renderRequestPreview(entries: RenderEntry[], expanded: boolean, labelColor: string, width: number): string[] {
  if (entries.length < 1) return [];

  const contentLines = buildContentLines(entries, labelColor, width);
  if (contentLines.length < 1) return [];

  const hintLine = truncateLine(renderHintLine(expanded ? "접기" : "더보기"), width);
  if (expanded) return [...contentLines, hintLine];

  if (contentLines.length <= COLLAPSED_MAX_LINES) return contentLines;

  const collapsed = contentLines.slice(0, COLLAPSED_MAX_LINES);
  collapsed[collapsed.length - 1] = truncateLine(appendEllipsis(collapsed[collapsed.length - 1] ?? ""), width);
  return [...collapsed, hintLine];
}

function buildContentLines(entries: RenderEntry[], labelColor: string, width: number): string[] {
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.label) lines.push(truncateLine(renderPrefixedLine(`${labelColor}▸ ${entry.label}${ANSI_RESET}`), width));

    const textLines = normalizeRequestLines(entry.text);
    const textIndent = entry.label ? "  " : "";
    for (const line of textLines) lines.push(truncateLine(renderPrefixedLine(`${textIndent}${line}`), width));
  }

  return lines;
}

function normalizeRequestLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").split("\n");
  return normalized.length > 0 ? normalized : [""];
}

function renderPrefixedLine(content: string): string {
  return `  ${DIM}${PREFIX}${ANSI_RESET} ${content}`;
}

function renderHintLine(label: string): string {
  return `  ${DIM}${PREFIX}${ANSI_RESET} ${PANEL_DIM_COLOR}${safeKeyHint(label)}${ANSI_RESET}`;
}

function truncateLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

function safeKeyHint(label: string): string {
  try {
    return keyHint("app.tools.expand", label);
  } catch {
    return `${DIM}⌃O ${label}${ANSI_RESET}`;
  }
}

function appendEllipsis(line: string): string {
  return line.endsWith("…") ? line : `${line}…`;
}

function requestDirectiveWithUi(ctx: ExtensionContext, questions: DirectiveQuestion[]): Promise<DirectiveResult> {
  const isMulti = questions.length > 1;
  const totalTabs = questions.length + (isMulti ? 1 : 0);

  return ctx.ui.custom<DirectiveResult>((tui, theme, _kb, done) => {
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionIdx = -1;
    let cachedWidth = -1;
    let cachedLines: string[] | undefined;
    const answers = new Map<number, DirectiveAnswer>();
    const multiSelections = new Map<number, Set<number>>();
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);

    function refresh() {
      cachedWidth = -1;
      cachedLines = undefined;
      tui.requestRender();
    }

    function submit(cancelled: boolean) {
      done({
        questions,
        answers: Array.from(answers.values()),
        cancelled,
      });
    }

    function currentQuestion(): DirectiveQuestion | undefined {
      return questions[currentTab];
    }

    function currentOptions(): RenderOption[] {
      const q = currentQuestion();
      if (!q) return [];
      const selectedSet = multiSelections.get(currentTab);
      const opts: RenderOption[] = q.options.map((o, i) => ({
        ...o,
        selected: selectedSet?.has(i) ?? false,
      }));
      opts.push({ label: "직접 입력", description: "대원수(Admiral of the Navy)가 직접 지시를 작성합니다.", isOther: true });
      return opts;
    }

    function allAnswered(): boolean {
      return questions.every((_, i) => answers.has(i));
    }

    function advanceAfterAnswer() {
      if (!isMulti) {
        submit(false);
        return;
      }
      if (currentTab < questions.length - 1) {
        currentTab++;
      } else {
        currentTab = questions.length;
      }
      optionIndex = 0;
      refresh();
    }

    function saveAnswer(qIdx: number, values: string[], wasCustom: boolean) {
      const q = questions[qIdx];
      answers.set(qIdx, {
        question: q.question,
        header: q.header,
        values,
        wasCustom,
      });
    }

    function getSelectedValues(qIdx: number): string[] {
      const q = questions[qIdx];
      const selected = multiSelections.get(qIdx);
      if (!q || !selected || selected.size === 0) return [];

      return Array.from(selected)
        .sort((a, b) => a - b)
        .map((i) => q.options[i])
        .filter((option): option is DirectiveOption => option !== undefined)
        .map((option) => option.label);
    }

    function syncMultiSelectionAnswer(qIdx: number): void {
      const values = getSelectedValues(qIdx);
      if (values.length === 0) {
        answers.delete(qIdx);
        return;
      }
      saveAnswer(qIdx, values, false);
    }

    function commitMultiSelect(qIdx: number) {
      const values = getSelectedValues(qIdx);
      if (values.length === 0) {
        answers.delete(qIdx);
        refresh();
        return;
      }
      saveAnswer(qIdx, values, false);
      advanceAfterAnswer();
    }

    editor.onSubmit = (value) => {
      if (inputQuestionIdx < 0) return;
      const trimmed = value.trim() || "(지시 없음)";
      if (questions[inputQuestionIdx]?.multiSelect) {
        multiSelections.delete(inputQuestionIdx);
      }
      saveAnswer(inputQuestionIdx, [trimmed], true);
      inputMode = false;
      inputQuestionIdx = -1;
      editor.setText("");
      advanceAfterAnswer();
    };

    function handleInput(data: string) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          inputMode = false;
          inputQuestionIdx = -1;
          editor.setText("");
          refresh();
          return;
        }
        editor.handleInput(data);
        refresh();
        return;
      }

      const q = currentQuestion();
      const opts = currentOptions();

      if (isMulti) {
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          currentTab = (currentTab + 1) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          currentTab = (currentTab - 1 + totalTabs) % totalTabs;
          optionIndex = 0;
          refresh();
          return;
        }
      }

      if (isMulti && currentTab === questions.length) {
        if (matchesKey(data, Key.enter) && allAnswered()) {
          submit(false);
        } else if (matchesKey(data, Key.escape)) {
          submit(true);
        }
        return;
      }

      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(opts.length - 1, optionIndex + 1);
        refresh();
        return;
      }

      if (matchesKey(data, Key.enter) && q) {
        const opt = opts[optionIndex];

        if (opt.isOther) {
          inputMode = true;
          inputQuestionIdx = currentTab;
          editor.setText("");
          refresh();
          return;
        }

        if (q.multiSelect) {
          const sel = multiSelections.get(currentTab);
          if (!sel || sel.size === 0) {
            saveAnswer(currentTab, [opt.label], false);
            advanceAfterAnswer();
          } else {
            commitMultiSelect(currentTab);
          }
          return;
        }

        saveAnswer(currentTab, [opt.label], false);
        advanceAfterAnswer();
        return;
      }

      if (matchesKey(data, Key.space) && q?.multiSelect) {
        const opt = opts[optionIndex];
        if (opt.isOther) {
          inputMode = true;
          inputQuestionIdx = currentTab;
          editor.setText("");
          refresh();
          return;
        }
        let selected = multiSelections.get(currentTab);
        if (!selected) {
          selected = new Set();
          multiSelections.set(currentTab, selected);
        }
        if (selected.has(optionIndex)) {
          selected.delete(optionIndex);
        } else {
          selected.add(optionIndex);
        }
        syncMultiSelectionAnswer(currentTab);
        refresh();
        return;
      }

      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    function render(width: number): string[] {
      if (cachedLines && cachedWidth === width) return cachedLines;
      cachedWidth = width;

      const lines: string[] = [];
      const q = currentQuestion();
      const opts = currentOptions();
      const add = (s: string) => lines.push(truncateToWidth(s, width));

      add(theme.fg("accent", "─".repeat(width)));
      add(theme.fg("accent", theme.bold(" ⚓ Directive Requested")));

      if (isMulti) {
        lines.push("");
        const tabs: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const isActive = i === currentTab;
          const isAnswered = answers.has(i);
          const lbl = questions[i].header;
          const box = isAnswered ? "■" : "□";
          const color = isAnswered ? "success" : "muted";
          const text = ` ${box} ${lbl} `;
          const styled = isActive
            ? theme.bg("selectedBg", theme.fg("text", text))
            : theme.fg(color, text);
          tabs.push(`${styled} `);
        }
        const canSubmit = allAnswered();
        const isSubmitTab = currentTab === questions.length;
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab
          ? theme.bg("selectedBg", theme.fg("text", submitText))
          : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled} →`);
        add(` ${tabs.join("")}`);
      }

      lines.push("");

      if (inputMode && q) {
        add(theme.fg("text", ` ${q.question}`));
        lines.push("");
        add(theme.fg("muted", " Admiral of the Navy (대원수)'s response:"));
        for (const line of editor.render(width - 2)) {
          add(` ${line}`);
        }
        lines.push("");
        add(theme.fg("dim", " Enter → 제출 • Esc → 돌아가기"));
      } else if (isMulti && currentTab === questions.length) {
        add(theme.fg("accent", theme.bold(" Directive Summary")));
        lines.push("");
        for (let i = 0; i < questions.length; i++) {
          const answer = answers.get(i);
          if (answer) {
            const prefix = answer.wasCustom ? "(직접 작성) " : "";
            const valStr = answer.values.join(", ");
            add(`${theme.fg("muted", ` ${answer.header}: `)}${theme.fg("text", prefix + valStr)}`);
          }
        }
        lines.push("");
        if (allAnswered()) {
          add(theme.fg("success", " Enter → 지시 제출"));
        } else {
          const missing = questions
            .filter((_, i) => !answers.has(i))
            .map((question) => question.header)
            .join(", ");
          add(theme.fg("warning", ` 미응답: ${missing}`));
        }
      } else if (q) {
        add(theme.fg("text", ` ${q.question}`));
        if (q.multiSelect) {
          add(theme.fg("dim", "   (Space: 토글 • Enter: 확정)"));
        }
        lines.push("");

        const showPreview = hasPreview(q);
        let previewContent: string | undefined;

        for (let i = 0; i < opts.length; i++) {
          const opt = opts[i];
          const isCursor = i === optionIndex;
          const isOther = opt.isOther === true;
          const isSelected = opt.selected === true;
          let prefix: string;
          if (q.multiSelect && !isOther) {
            const check = isSelected ? "☑" : "☐";
            prefix = isCursor ? theme.fg("accent", `> ${check} `) : `  ${check} `;
          } else {
            prefix = isCursor ? theme.fg("accent", "> ") : "  ";
          }

          const color = isCursor ? "accent" : "text";
          const num = isOther ? "·" : `${i + 1}`;
          add(prefix + theme.fg(color, `${num}. ${opt.label}`));

          if (opt.description && !isOther) {
            add(`     ${theme.fg("muted", opt.description)}`);
          }

          if (isCursor && showPreview && opt.preview) {
            previewContent = opt.preview;
          }
        }

        if (showPreview && previewContent) {
          lines.push("");
          add(theme.fg("accent", "── Preview ──"));
          const previewLines = previewContent.split("\n");
          for (const pl of previewLines) {
            add(` ${theme.fg("muted", pl)}`);
          }
        }
      }

      lines.push("");
      if (!inputMode) {
        const help = isMulti
          ? " Tab/←→ 탭 이동 • ↑↓ 선택 • Enter 확정 • Esc 취소"
          : q?.multiSelect
            ? " ↑↓ 이동 • Space 토글 • Enter 확정 • Esc 취소"
            : " ↑↓ 이동 • Enter 선택 • Esc 취소";
        add(theme.fg("dim", help));
      }
      add(theme.fg("accent", "─".repeat(width)));

      cachedLines = lines;
      return lines;
    }

    return {
      render,
      invalidate: () => {
        cachedWidth = -1;
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

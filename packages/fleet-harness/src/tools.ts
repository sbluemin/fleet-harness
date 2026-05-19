import type { ExtensionAPI, ExtensionContext, Theme } from "@sbluemin/fleet-coding-agent";
import { keyHint } from "@sbluemin/fleet-coding-agent";
import { truncateToWidth, visibleWidth } from "@sbluemin/fleet-tui";
import type { CliType } from "@sbluemin/fleet-unified-agent";
import {
  admiral,
  infra,
  AgentToolSpec,
  BackendProgress,
  CarrierConfig,
  CarrierMetadata,
  TaskForceResult,
  TaskForceState,
} from "@sbluemin/fleet-core";
import { FLEET_WIKI_AGENT_TOOL_IDS } from "@sbluemin/fleet-wiki";

import { syncModelConfig } from "./panel/config.js";
import { renderCarrierJobsCall, renderCarrierJobsResult, type CarrierJobsToolResult } from "./jobs.js";
import { getFleetRuntime } from "./fleet.js";
import {
  createDefaultResponseRenderer,
  createDefaultUserRenderer,
} from "./panel/message-render.js";

export type { BackendProgress, CarrierConfig, TaskForceResult, TaskForceState };
export const {
  getOfflineCarrierIds,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  isCarrierOnline,
  notifyStatusUpdate,
  resolveCarrierBgColor,
  resolveCarrierColor,
  resolveCarrierDisplayName,
  resolveCarrierRgb,
  setCarrierOffline,
  setCarrierOnline,
  setOfflineCarriers,
  setTaskForceConfiguredCarriers,
  updateCarrierCliType,
} = admiral.carrier;
const admiralAny = admiral as any;
const carrierFrameworkApi = admiralAny.carrier?.framework ?? admiralAny.carrier;
export const resolveCarrierCliType = carrierFrameworkApi.resolveCarrierCliType as (
  carrierId: string,
  defaultCliType: CliType,
) => CliType;
const {
  ANSI_RESET,
  CARRIER_BG_COLORS,
  CARRIER_COLORS,
  CLI_DISPLAY_NAMES,
  PANEL_DIM_COLOR,
  SORTIE_SUMMARY_COLOR,
  TASKFORCE_BADGE_COLOR,
} = admiral.constants;
const carrierCore = admiral.carrier;

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
  /** 소스레벨 기본 모델 ID — states.json에 저장된 값이 없을 때 폴백 */
  defaultModel?: string;
  /** 소스레벨 기본 추론 강도 — 신규 모델 엔트리 시딩 시에만 사용 */
  defaultEffort?: string;
}

const COLLAPSED_MAX_LINES = 5;
const PREFIX = "╎";
const DIM = "\x1b[2m";

// fleet-wiki가 fleet-core registry에 self-register한 4종 read-only tool ID 집합.
// `registerFleetWiki`가 host에 compact wiki UI(`withCompactRender`)와 함께 먼저 등록하므로,
// `registerFleetPiTools`는 이 집합을 skip하여 generic core wrapper로 덮어쓰지 않는다.
const WIKI_HOST_OWNED_TOOL_IDS: ReadonlySet<string> = new Set(FLEET_WIKI_AGENT_TOOL_IDS);

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
  const specs = getFleetRuntime().admiral.agent.tools.listSpecs();

  for (const spec of specs) {
    if (WIKI_HOST_OWNED_TOOL_IDS.has(spec.id)) {
      // host PI tool 등록은 `registerFleetWiki`가 소유한다. compact wiki UI 보존을 위해 skip.
      continue;
    }
    pi.registerTool(toPiToolConfig(spec) as any);
  }
}


export function registerCarrier(pi: ExtensionAPI, config: CarrierConfig): void {
  carrierCore.registerCarrier(config);

  const liveRenderConfig = createLiveRenderConfig(config);
  const userRenderer = config.renderUser ?? createDefaultUserRenderer(liveRenderConfig);
  pi.registerMessageRenderer(`${config.id}-user`, userRenderer);

  const responseRenderer = config.renderResponse ?? createDefaultResponseRenderer(liveRenderConfig);
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
    defaultModel: options.defaultModel,
    defaultEffort: options.defaultEffort,
  };
  registerCarrier(pi, config);

  carrierCore.reorderRegisteredByCliType();
}

function createLiveRenderConfig(config: CarrierConfig): CarrierConfig {
  const liveConfig = Object.create(config) as CarrierConfig;
  Object.defineProperty(liveConfig, "displayName", {
    configurable: true,
    enumerable: true,
    get() {
      return resolveCarrierDisplayName(config.id);
    },
  });
  return liveConfig;
}

export function ensureShipyardLogCategories(): void {
  if (shipyardLogCategoriesRegistered) {
    return;
  }
  shipyardLogCategoriesRegistered = true;
  infra.log.getLogAPI().registerCategory({
    id: "prompt",
    label: "Carrier Prompt",
    description: "캐리어 프롬프트 전문 로그",
  });
}

function toPiToolConfig(spec: AgentToolSpec): Record<string, unknown> {
  return {
    name: spec.id,
    label: spec.title,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    renderShell: "self",
    promptGuidelines: [
      ...spec.whenToUse,
      ...spec.whenNotToUse,
      ...spec.usageGuidelines,
      ...(spec.guardrails ?? []),
    ],
    parameters: spec.parameters,
    renderCall(args: unknown, theme: Theme, context: PiRenderContext) {
      return renderToolCall(spec, args, theme, context);
    },
    renderResult(result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: PiRenderContext) {
      return renderToolResult(spec, result, options, theme, context);
    },
    execute(id: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const runtime = getFleetRuntime();
      return runtime.admiral.agent.tools.invoke(spec.id, params, { cwd: ctx.cwd, toolCallId: id, signal });
    },
  } as any;
}

function renderToolCall(spec: AgentToolSpec, args: unknown, _theme: Theme, context: PiRenderContext): unknown {
  if (spec.id === "carrier_jobs") {
    return renderCarrierJobsCall(args, context);
  }
  if (spec.id === "carrier_taskforce") {
    const typedArgs = args as { carrier?: string };
    return oneLine(`  ⚓ ${TASKFORCE_BADGE_COLOR}Taskforce${ANSI_RESET}: ${TASKFORCE_BADGE_COLOR}${typedArgs.carrier ?? "..."}${ANSI_RESET}`);
  }
  if (spec.id === "carrier_dispatch") {
    const carrierId = isRecord(args) && typeof args.carrier_id === "string" ? args.carrier_id : "";
    const label = isRecord(args) && typeof args.label === "string" ? args.label.trim() : "";
    const carrierColor = CARRIER_COLORS[carrierId] ?? SORTIE_SUMMARY_COLOR;
    const carrierName = resolveCarrierDisplayName(carrierId) || carrierId;
    const suffix = label ? ` — ${label}` : "";
    return oneLine(`  ⚓ ${carrierColor}${carrierName}${ANSI_RESET}${suffix}`);
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
  if (spec.id === "carrier_jobs") {
    return renderCarrierJobsResult(result as CarrierJobsToolResult);
  }
  const entries = buildPreviewEntries(spec.id, context.args);
  const color = spec.id === "carrier_taskforce"
      ? TASKFORCE_BADGE_COLOR
      : spec.id === "carrier_dispatch"
        ? (CARRIER_COLORS[(context.args as { carrier_id?: string })?.carrier_id ?? ""] ?? SORTIE_SUMMARY_COLOR)
        : resolveToolCarrierColor(spec.id);
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

  if (toolName === "carrier_dispatch" && typeof args.carrier_id === "string" && typeof args.request === "string") {
    const carrierId = args.carrier_id;
    const carrierName = resolveCarrierDisplayName(carrierId) || carrierId;
    const label = typeof args.label === "string" && args.label.trim().length > 0
      ? `${carrierName} — ${args.label.trim()}`
      : carrierName;
    return [{ label, text: String(args.request) }];
  }

  if (toolName === "carrier_taskforce" && typeof args.request === "string") {
    return [{ label: "", text: args.request }];
  }

  return [];
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

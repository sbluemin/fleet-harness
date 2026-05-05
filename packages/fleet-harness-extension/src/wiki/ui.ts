import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, type ExtensionCommandContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Spacer, Text, truncateToWidth, visibleWidth, type SelectItem, type TUI } from "@mariozechner/pi-tui";

import { buildBriefingToolConfig } from "@sbluemin/fleet-wiki";
import { buildCompileSourceToolConfig } from "@sbluemin/fleet-wiki";
import { buildDryDockToolConfig } from "@sbluemin/fleet-wiki";
import { buildIngestToolConfig } from "@sbluemin/fleet-wiki";
import { buildOrientToolConfig } from "@sbluemin/fleet-wiki";
import { buildPatchQueueToolConfig } from "@sbluemin/fleet-wiki";
import { buildQueryToolConfig } from "@sbluemin/fleet-wiki";
import { buildReadToolConfig } from "@sbluemin/fleet-wiki";
import { buildResolveToolConfig } from "@sbluemin/fleet-wiki";

import {
  approveAndNotify,
  listQueueItems,
  rejectAndNotify,
  runCapture,
  runDrydock,
  runStatus,
  showPatchDetail,
} from "./handlers.js";
import type { PatchMeta, PatchOp } from "@sbluemin/fleet-wiki";

export type {
  BriefingHit,
  DryDockIssue,
  DryDockReport,
  WikiIndexEntry,
  MemoryPaths,
  Patch,
  PatchFrontmatter,
  PatchMeta,
  PatchOp,
  PatchStatus,
  RawSourceEntry,
  WikiEntry,
} from "@sbluemin/fleet-wiki";

type FleetWikiRegistrationContext = ExtensionContext & Pick<ExtensionAPI, "registerCommand" | "registerTool">;
type CompactRenderOptions = { expanded: boolean; isPartial: boolean };

interface CompactRenderableResult {
  render(width: number): string[];
}

interface FleetWikiToolConfig {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<unknown>;
  renderCall?: (args: unknown, theme: Theme) => Text;
  renderResult?: (result: unknown, options: CompactRenderOptions, theme: Theme) => CompactRenderableResult;
}

const COMPACT_CALL_WIDTH = 60;

export function registerFleetWiki(ctx: ExtensionAPI | ExtensionContext): void {
  const pi = ctx as FleetWikiRegistrationContext;

  pi.registerTool(withCompactRender(buildIngestToolConfig()));
  pi.registerTool(withCompactRender(buildBriefingToolConfig()));
  pi.registerTool(withCompactRender(buildDryDockToolConfig()));
  pi.registerTool(withCompactRender(buildPatchQueueToolConfig()));
  pi.registerTool(withCompactRender(buildOrientToolConfig()));
  pi.registerTool(withCompactRender(buildReadToolConfig()));
  pi.registerTool(withCompactRender(buildResolveToolConfig()));
  pi.registerTool(withCompactRender(buildCompileSourceToolConfig()));
  pi.registerTool(withCompactRender(buildQueryToolConfig()));
  registerWikiCommands(pi);
}

export function registerWikiCommands(pi: Pick<ExtensionAPI, "registerCommand">): void {
  pi.registerCommand("fleet:wiki:menu", {
    description: "Fleet Wiki 인터랙티브 허브",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await openWikiHub(pi as ExtensionAPI, ctx);
    },
  });
}

export default registerFleetWiki;

type HubAction = "queue" | "capture" | "status" | "drydock";
type HubMode = "main" | "queue-list" | "queue-detail";
type HubResult = `approve:${string}` | `reject:${string}` | "capture" | "status" | "drydock" | null;

interface QueueItemState {
  id: string;
  summary: string;
}

interface QueueDetailState {
  body: string;
  fromSingle: boolean;
  meta: PatchMeta;
  op: PatchOp;
  summary: string;
  target: string;
}

interface HubState {
  detail: QueueDetailState | null;
  items: QueueItemState[];
  mode: HubMode;
}

const MAIN_ACTIONS = new Map<string, HubAction>([
  ["패치 큐 관리", "queue"],
  ["세션 캡처", "capture"],
  ["저장소 상태", "status"],
  ["정적 점검 (Drydock)", "drydock"],
]);

const MAIN_MENU_ITEMS: SelectItem[] = [
  { value: "패치 큐 관리", label: "패치 큐 관리", description: "승인 대기 중인 Fleet Wiki 패치를 탐색하고 처리합니다." },
  { value: "세션 캡처", label: "세션 캡처", description: "현재 세션을 Fleet Wiki capture 흐름으로 넘깁니다." },
  { value: "저장소 상태", label: "저장소 상태", description: "Fleet Wiki 저장소 초기화 상태를 확인합니다." },
  { value: "정적 점검 (Drydock)", label: "정적 점검 (Drydock)", description: "Fleet Wiki 정적 점검을 실행합니다." },
];

const DETAIL_MENU_ITEMS: SelectItem[] = [
  { value: "approve", label: "승인", description: "현재 패치를 승인합니다." },
  { value: "reject", label: "반려", description: "현재 패치를 반려합니다." },
  { value: "back", label: "뒤로", description: "이전 화면으로 돌아갑니다." },
];

const BODY_PREVIEW_MAX_LINES = 20;

function withCompactRender<T extends FleetWikiToolConfig>(tool: T): T {
  return {
    ...tool,
    renderCall(args: unknown, theme: Theme) {
      const action = getWikiActionName(tool.name);
      const header = theme.fg("toolTitle", theme.bold(`⚓ Wiki: ${action}`));
      const summary = theme.fg("muted", `   ▸ ${formatCompactSummary(args)}`);
      const line = truncateToWidth(`${header} ${summary}`, COMPACT_CALL_WIDTH, "...");
      return new Text(line, 0, 0);
    },
    renderResult(result: unknown, options: CompactRenderOptions, theme: Theme): CompactRenderableResult {
      return {
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const action = getWikiActionName(tool.name);
          const status = options.isPartial ? "running" : "done";
          const header = options.isPartial
            ? theme.fg("warning", `⚓ Wiki: ${action} (${status})`)
            : theme.fg("success", `⚓ Wiki: ${action} (${status})`);
          const summary = theme.fg("muted", `   ▸ ${options.isPartial ? "실행 중..." : formatCompactSummary(extractCompactResultPayload(result))}`);
          return [truncateToWidth(`${header} ${summary}`, safeWidth, "...")];
        },
      };
    },
  };
}

function getWikiActionName(toolName: string): string {
  return toolName.startsWith("wiki_") ? toolName.slice("wiki_".length) : toolName;
}

function formatCompactSummary(value: unknown): string {
  return toSingleLineJson(value);
}

function extractCompactResultPayload(result: unknown): unknown {
  const content = Array.isArray((result as { content?: unknown[] } | undefined)?.content)
    ? (result as { content: Array<{ type?: string; text?: string }> }).content
    : [];
  const first = content[0];
  if (first?.type === "text" && typeof first.text === "string" && first.text.trim().length > 0) {
    return tryParseJson(first.text);
  }
  return result;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toSingleLineJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized.replace(/\s+/g, " ").trim();
    }
  } catch {
    // JSON 직렬화에 실패하면 문자열 표현으로 축약한다.
  }
  return String(value).replace(/\s+/g, " ").trim();
}

export async function openWikiHub(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const result = await ctx.ui.custom<HubResult>(
    (tui, theme, _kb, done) => createWikiHubOverlay(tui, theme, ctx, done),
    {
      overlay: true,
      overlayOptions: {
        width: "60%",
        maxHeight: "70%",
        anchor: "center",
      },
    },
  );

  if (result === null) {
    return;
  }

  if (result === "capture") {
    await runCapture(pi, ctx);
    return;
  }

  if (result === "status") {
    await runStatus(ctx);
    return;
  }

  if (result === "drydock") {
    await runDrydock(ctx);
    return;
  }

  if (result.startsWith("approve:")) {
    await approveAndNotify(result.slice("approve:".length), ctx);
    return;
  }

  if (result.startsWith("reject:")) {
    const reason = await ctx.ui.input("반려 사유", "rejected");
    if (reason === undefined) {
      return;
    }
    await rejectAndNotify(result.slice("reject:".length), reason, ctx);
  }
}

function createWikiHubOverlay(
  tui: TUI,
  theme: Theme,
  ctx: ExtensionCommandContext,
  done: (value: HubResult) => void,
) {
  let settled = false;
  const state: HubState = {
    detail: null,
    items: [],
    mode: "main",
  };

  let activeList = createPlaceholderList(theme);
  const setActiveList = (nextList: SelectList) => {
    activeList = nextList;
  };

  const settleAndDone = (value: HubResult) => {
    settled = true;
    done(value);
  };

  setActiveList(buildActiveList(tui, theme, state, ctx, settleAndDone, setActiveList, () => settled));

  return {
    render(width: number) {
      return renderOverlay(width, theme, state, activeList);
    },
    invalidate() {},
    handleInput(data: string) {
      if (settled) {
        return;
      }
      if (matchesKey(data, Key.escape)) {
        handleEscape(tui, theme, state, ctx, settleAndDone, setActiveList, () => settled);
        tui.requestRender();
        return;
      }

      activeList.handleInput(data);
      tui.requestRender();
    },
  };
}

function renderOverlay(
  width: number,
  theme: Theme,
  state: HubState,
  activeList: SelectList,
): string[] {
  const border = (text: string) => theme.fg("border", text);
  const title = ` ${getTitle(state.mode)} `;
  const innerWidth = Math.max(1, width - 4);
  const sideWidth = Math.max(0, Math.floor((width - 2 - title.length) / 2));
  const rightWidth = Math.max(0, width - 2 - sideWidth - title.length);
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", theme.bold(getTitle(state.mode)))));
  container.addChild(new Spacer(1));

  if (state.mode === "queue-detail" && state.detail) {
    container.addChild(new Text(formatPatchMeta(theme, state.detail)));
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", formatPatchBody(state.detail.body))));
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    container.addChild(new Spacer(1));
  }

  container.addChild(activeList);
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", "Enter 선택 │ Esc 뒤로")));

  const bodyLines = container.render(innerWidth);
  const row = (content: string) => {
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return border("│ ") + content + " ".repeat(pad) + border(" │");
  };

  return [
    border("╭" + "─".repeat(sideWidth) + title + "─".repeat(rightWidth) + "╮"),
    ...bodyLines.map((line) => row(line)),
    border("╰" + "─".repeat(width - 2) + "╯"),
  ];
}

function createMainList(
  tui: TUI,
  theme: Theme,
  state: HubState,
  ctx: ExtensionCommandContext,
  done: (value: HubResult) => void,
  setActiveList: (list: SelectList) => void,
  isSettled: () => boolean,
): SelectList {
  const selectList = new SelectList(MAIN_MENU_ITEMS, MAIN_MENU_ITEMS.length, buildSelectTheme(theme));

  selectList.onSelect = (item) => {
    void (async () => {
      try {
        const action = MAIN_ACTIONS.get(String(item.value));
        if (!action) {
          return;
        }
        if (action !== "queue") {
          done(action);
          return;
        }
        if (isSettled()) {
          return;
        }

        const items = await listQueueItems(ctx.cwd);
        if (isSettled()) {
          return;
        }
        if (items.length === 0) {
          ctx.ui.notify("큐가 비어 있습니다.", "info");
          return;
        }

        state.items = items;
        if (items.length === 1) {
          const detail = await showPatchDetail(items[0]!.id, ctx.cwd);
          if (isSettled()) {
            return;
          }
          state.detail = {
            body: detail.body,
            fromSingle: true,
            meta: detail.meta,
            op: detail.op,
            summary: detail.summary,
            target: detail.target,
          };
          state.mode = "queue-detail";
        } else {
          state.mode = "queue-list";
        }

        setActiveList(buildActiveList(tui, theme, state, ctx, done, setActiveList, isSettled));
        tui.requestRender();
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : "Queue error", "warning");
      }
    })();
  };

  selectList.onCancel = () => {
    if (isSettled()) {
      return;
    }
    done(null);
  };
  return selectList;
}

function createQueueList(
  tui: TUI,
  theme: Theme,
  state: HubState,
  ctx: ExtensionCommandContext,
  done: (value: HubResult) => void,
  setActiveList: (list: SelectList) => void,
  isSettled: () => boolean,
): SelectList {
  const items: SelectItem[] = state.items.map((item) => ({
    value: item.id,
    label: item.id,
    description: item.summary,
  }));
  const selectList = new SelectList(items, Math.min(items.length, 10), buildSelectTheme(theme));

  selectList.onSelect = (item) => {
    void (async () => {
      try {
        if (isSettled()) {
          return;
        }
        const detail = await showPatchDetail(String(item.value), ctx.cwd);
        if (isSettled()) {
          return;
        }
        state.detail = {
          body: detail.body,
          fromSingle: false,
          meta: detail.meta,
          op: detail.op,
          summary: detail.summary,
          target: detail.target,
        };
        state.mode = "queue-detail";
        setActiveList(buildActiveList(tui, theme, state, ctx, done, setActiveList, isSettled));
        tui.requestRender();
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : "Queue error", "warning");
      }
    })();
  };

  selectList.onCancel = () => {
    if (isSettled()) {
      return;
    }
    state.mode = "main";
    setActiveList(buildActiveList(tui, theme, state, ctx, done, setActiveList, isSettled));
    tui.requestRender();
  };

  return selectList;
}

function createDetailList(
  tui: TUI,
  theme: Theme,
  state: HubState,
  ctx: ExtensionCommandContext,
  done: (value: HubResult) => void,
  setActiveList: (list: SelectList) => void,
  isSettled: () => boolean,
): SelectList {
  const selectList = new SelectList(DETAIL_MENU_ITEMS, DETAIL_MENU_ITEMS.length, buildSelectTheme(theme));

  selectList.onSelect = (item) => {
    if (isSettled()) {
      return;
    }
    const action = String(item.value);
    const patchId = state.detail?.meta.id;
    if (!patchId) {
      done(null);
      return;
    }

    if (action === "approve") {
      done(`approve:${patchId}`);
      return;
    }
    if (action === "reject") {
      done(`reject:${patchId}`);
      return;
    }

    goBackFromDetail(state);
    setActiveList(buildActiveList(tui, theme, state, ctx, done, setActiveList, isSettled));
    tui.requestRender();
  };

  selectList.onCancel = () => {
    if (isSettled()) {
      return;
    }
    goBackFromDetail(state);
    setActiveList(buildActiveList(tui, theme, state, ctx, done, setActiveList, isSettled));
    tui.requestRender();
  };

  return selectList;
}

function createPlaceholderList(theme: Theme): SelectList {
  return new SelectList([], 1, buildSelectTheme(theme));
}

function handleEscape(
  tui: TUI,
  theme: Theme,
  state: HubState,
  ctx: ExtensionCommandContext,
  done: (value: HubResult) => void,
  setActiveList: (list: SelectList) => void,
  isSettled: () => boolean,
): void {
  if (state.mode === "main") {
    done(null);
    return;
  }

  if (state.mode === "queue-detail") {
    goBackFromDetail(state);
  } else {
    state.mode = "main";
  }

  setActiveList(buildActiveList(tui, theme, state, ctx, done, setActiveList, isSettled));
}

function buildActiveList(
  tui: TUI,
  theme: Theme,
  state: HubState,
  ctx: ExtensionCommandContext,
  done: (value: HubResult) => void,
  setActiveList: (list: SelectList) => void,
  isSettled: () => boolean,
): SelectList {
  if (state.mode === "queue-list") {
    return createQueueList(tui, theme, state, ctx, done, setActiveList, isSettled);
  }
  if (state.mode === "queue-detail") {
    return createDetailList(tui, theme, state, ctx, done, setActiveList, isSettled);
  }
  return createMainList(tui, theme, state, ctx, done, setActiveList, isSettled);
}

function getTitle(mode: HubMode): string {
  if (mode === "queue-list") {
    return "Fleet Wiki › 패치 큐";
  }
  if (mode === "queue-detail") {
    return "Fleet Wiki › 패치 상세";
  }
  return "Fleet Wiki";
}

function formatPatchMeta(theme: Theme, detail: QueueDetailState): string {
  const lines = [
    `ID: ${detail.meta.id}`,
    `Op: ${detail.op}`,
    `Target: ${detail.target}`,
    `Summary: ${detail.summary}`,
    `Status: ${detail.meta.status}`,
  ];
  return lines.map((line) => theme.fg("text", line)).join("\n");
}

function formatPatchBody(body: string): string {
  const lines = body.split("\n");
  if (lines.length <= BODY_PREVIEW_MAX_LINES) {
    return body;
  }
  return [...lines.slice(0, BODY_PREVIEW_MAX_LINES), "... (truncated)"].join("\n");
}

function buildSelectTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function goBackFromDetail(state: HubState): void {
  if (state.detail?.fromSingle) {
    state.mode = "main";
  } else {
    state.mode = "queue-list";
  }
  state.detail = null;
}

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { attachStatusContext, detachStatusContext, refreshStatusNow } from "@sbluemin/unified-agent";
import type { CliType, ServiceStatusContextPort } from "@sbluemin/unified-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { createFleetCoreRuntime, type FleetCoreRuntimeContext } from "@sbluemin/fleet-core";
import {
  buildSystemPrompt,
  getActiveProtocol,
  getAllProtocols,
  setActiveProtocol,
} from "@sbluemin/fleet-core/admiral";
import {
  bindHostSession,
  cleanIdle,
} from "@sbluemin/fleet-core";
import {
  composeOperationNameRequest,
  loadSettings as loadOperationNameSettings,
  sanitizeOperationNameDisplay,
} from "@sbluemin/fleet-core/metaphor/operation-name";
import { registerDefaultCarrierPersonas } from "@sbluemin/fleet-core/admiral/carrier/personas";
import {
  getConfiguredTaskForceCarrierIds,
  loadOfflineCarriers,
  loadSquadronEnabled,
  reconcileActiveModelSelections,
  saveSquadronEnabled,
} from "@sbluemin/fleet-core/admiral/store";
import { isWorldviewEnabled } from "@sbluemin/fleet-core/metaphor";
import { getLogAPI } from "@sbluemin/fleet-core/services/log";
import { bootBridge, ensureBridgeKeybinds } from "./bridge/handler.js";
import { syncModelConfig } from "./panel/config.js";
import { completeSimple } from "./provider.js";
import type { Api, Model, ThinkingLevel } from "./provider.js";
import { registerGrandFleet } from "./grand-fleet/index.js";
import { getKeybindAPI } from "./keybinds.js";
import { detachAgentPanelUi, refreshAgentPanel } from "./panel/ui.js";
import { requestHudRender } from "./hud/editor.js";
import { setDeliverAs, getDeliverAs } from "./settings.js";
import {
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  getSquadronEnabledIds,
  notifyStatusUpdate,
  registerRequestDirective,
  registerSingleCarrier,
  setOfflineCarriers,
  setSquadronEnabledCarriers,
  setTaskForceConfiguredCarriers,
} from "./tools.js";
import { setEditorBorderColor, setEditorRightLabel, setEditorTopRightLabel } from "./hud/border-bridge.js";
import { setCarrierJobsVerbose, toggleCarrierJobsVerbose } from "./jobs.js";

export interface FleetLifecycleRuntime {
  fleetEnabled: boolean;
}

export interface BootConfig {
  dev: boolean;
  experimental: boolean;
  fleet: boolean;
  grandFleet: boolean;
  role: string | null;
}

interface OperationNameGlobalState {
  sessionId: string;
  displayName?: string;
  pending: boolean;
}

interface OperationNameSessionState {
  displayName?: string;
  pending: boolean;
}

interface OperationNameGlobalStore {
  currentSessionId?: string;
  sessions: Record<string, OperationNameSessionState | undefined>;
}

interface PiServiceStatusContextLike {
  hasUI?: boolean;
  sessionManager?: {
    getSessionId?: () => string;
  };
  ui?: {
    notify?: (message: string, level: "info" | "warning") => void;
  };
}

const OPERATION_NAME_ATTEMPTS = new Set<string>();

let fleetRuntime: FleetCoreRuntimeContext | undefined;
let bootConfig: BootConfig | null = null;
let reconciliationScheduled = false;
let operationNameStore: OperationNameGlobalStore | OperationNameGlobalState | null = null;

export { bootBridge, ensureBridgeKeybinds };

export function registerFleetLifecycle(pi: ExtensionAPI): FleetLifecycleRuntime {
  if (!shouldBootFleet()) {
    registerGrandFleet(pi);
    return { fleetEnabled: false };
  }

  const dataDir = resolveFleetDataDir();
  initializeFleetRuntime(dataDir, pi);

  bootAdmiral(pi);
  bootstrapFleetState(pi);
  wireFleetPiEvents(pi);
  registerGrandFleet(pi);

  return { fleetEnabled: true };
}

export default function registerBoot(pi: ExtensionAPI): void {
  const role = process.env.PI_GRAND_FLEET_ROLE;
  const dev = process.env.PI_FLEET_DEV === "1";
  const experimental = process.env.PI_EXPERIMENTAL === "1";
  const isAdmiralty = role === "admiralty";
  const isFleet = role === "fleet";

  bootConfig = {
    dev,
    experimental,
    fleet: !isAdmiralty,
    grandFleet: isAdmiralty || isFleet,
    role: isAdmiralty ? "admiralty" : isFleet ? "fleet" : null,
  };
}

export function getBootConfig(): BootConfig | null {
  return bootConfig;
}

export function shouldBootFleet(): boolean {
  const bootCfg = getBootConfig();
  return bootCfg?.fleet !== false;
}

export function resolveFleetDataDir(): string {
  return path.join(os.homedir(), ".pi", "fleet");
}

export function initializeFleetRuntime(dataDir: string, pi?: ExtensionAPI): void {
  void pi;
  fleetRuntime = createFleetCoreRuntime({ dataDir, bootMode: bootConfig?.dev ? "dev" : "normal" });
}

export function getFleetRuntime(): FleetCoreRuntimeContext {
  if (!fleetRuntime) {
    throw new Error("Fleet core runtime has not been initialized.");
  }
  return fleetRuntime;
}

export async function shutdownFleetRuntime(): Promise<void> {
  const runtime = fleetRuntime;
  fleetRuntime = undefined;
  await runtime?.shutdown();
}

export function restoreFleetPreRegistrationState(): void {
  const restoredDisabled = loadOfflineCarriers();
  setOfflineCarriers(restoredDisabled);

  const restoredSquadron = loadSquadronEnabled();
  setSquadronEnabledCarriers(restoredSquadron);
}

export function registerFleetCarriers(pi: ExtensionAPI): void {
  registerDefaultCarrierPersonas({
    register(cli, metadata, options) {
      registerSingleCarrier(pi, cli, metadata, options);
    },
  });
}

export function bootstrapFleetState(pi: ExtensionAPI): void {
  restoreFleetPreRegistrationState();
  registerFleetCarriers(pi);
  scheduleFleetReconciliation();
}

export function scheduleFleetReconciliation(): void {
  if (reconciliationScheduled) return;
  reconciliationScheduled = true;
  setTimeout(() => {
    try {
      reconcileRegisteredCarrierModels();
      pruneStaleSquadronIds();
      syncTaskForceConfiguredCarriers();
      notifyStatusUpdate();
    } finally {
      reconciliationScheduled = false;
    }
  }, 0);
}

export function wireFleetPiEvents(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    scheduleOperationNameGeneration(ctx, event.prompt);
    if (process.env.PI_GRAND_FLEET_ROLE === "fleet") return;
    const fleetPrompt = buildSystemPrompt();
    getLogAPI().debug("acp-system-prompt", fleetPrompt, { category: "acp-system-prompt" });
    return { systemPrompt: fleetPrompt };
  });

  pi.on("session_start", (_event, ctx) => {
    bindFleetHostSession(ctx);
    bootstrapFleetState(pi);
    syncModelConfig();
    syncProtocolToHud(getActiveProtocol());
    registerAdmiralSettingsSection();
    ensureBridgeKeybinds();
  });

  pi.on("session_tree", (_event, ctx) => {
    bindFleetHostSession(ctx);
    syncModelConfig();
    registerAdmiralSettingsSection();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    detachAgentPanelUi();
    detachStatusContext();
    persistDirectChatIfEmpty(ctx);
    await shutdownFleetRuntime();
  });
}

export function registerFleetPiCommands(pi: ExtensionAPI): void {
  pi.registerCommand("fleet:agent:status", {
    description: "지원 CLI 서비스 상태를 즉시 새로고침",
    handler: async (_args, ctx) => {
      await refreshStatusNow(toServiceStatusContext(ctx));
    },
  });

  pi.registerCommand("fleet:jobs:verbose", {
    description: "carrier_jobs 렌더링 상세 모드 토글",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      const enabled = value === "on"
        ? (setCarrierJobsVerbose(true), true)
        : value === "off"
          ? (setCarrierJobsVerbose(false), false)
          : toggleCarrierJobsVerbose();
      ctx.ui.notify(`Carrier Jobs verbose: ${enabled ? "ON" : "OFF"}`, "info");
    },
  });

  pi.registerCommand("fleet:jobs:mode", {
    description: "carrier-result push delivery mode selector (follow-up | steer)",
    handler: async (_args, ctx) => {
      const current = getDeliverAs();
      const items: SelectItem[] = [
        {
          value: "followUp",
          label: current === "followUp" ? "Follow-up (recommended, default) (active)" : "Follow-up (recommended, default)",
          description: "Carrier result is pushed once per finalized job after the current turn ends. doctrinal default.",
        },
        {
          value: "steer",
          label: current === "steer" ? "Steer (advanced) (active)" : "Steer (advanced)",
          description: "Carrier result is pushed once per finalized job and may interrupt an ongoing response. Use only when latency truly matters.",
        },
      ];

      const result = await ctx.ui.custom<"followUp" | "steer" | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select Push Delivery Mode"))));

        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });

        selectList.onSelect = (item) => done(item.value as "followUp" | "steer");
        selectList.onCancel = () => done(null);

        container.addChild(selectList);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!result) return;
      await setDeliverAs(result);
      const label = result === "followUp" ? "Follow-up (recommended, default)" : "Steer (advanced)";
      ctx.ui.notify(`Push delivery mode: ${label}`, "info");
    },
  });
}

function bootAdmiral(pi: ExtensionAPI): void {
  const bootProtocol = getActiveProtocol();
  syncProtocolToHud(bootProtocol);
  registerAdmiralSettingsSection();
  registerRequestDirective(pi);
  registerProtocolKeybinds();
}

function registerProtocolKeybinds(): void {
  const keybind = getKeybindAPI();

  for (const protocol of getAllProtocols()) {
    keybind.register({
      extension: "admiral",
      action: `protocol:${protocol.id}`,
      defaultKey: `alt+${protocol.slot}`,
      description: `프로토콜 전환: ${protocol.name}`,
      category: "Admiral Protocol",
      handler: (ctx: any) => {
        const current = getActiveProtocol();
        if (current.id === protocol.id) {
          return;
        }
        setActiveProtocol(protocol.id);
        syncProtocolToHud(protocol);
        ctx.ui.notify(`Protocol → ${protocol.name}`, "info");
      },
    });
  }
}

function persistDirectChatIfEmpty(ctx: ExtensionContext): void {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return;

  const entries = ctx.sessionManager.getEntries();
  const hasDirectChat = entries.some((entry) => entry.type === "custom_message");
  if (!hasDirectChat) return;

  const hasAssistant = entries.some(
    (entry) => entry.type === "message" && (entry as any).message?.role === "assistant",
  );
  if (hasAssistant) return;

  const header = ctx.sessionManager.getHeader();
  if (!header) return;

  const dir = path.dirname(sessionFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let content = JSON.stringify(header) + "\n";
  for (const entry of entries) {
    content += JSON.stringify(entry) + "\n";
  }
  writeFileSync(sessionFile, content);
}

function bindFleetHostSession(ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  bindHostSession(sessionId);
  syncOperationNameSession(sessionId);
  cleanIdle();
  refreshAgentPanel(ctx);
  attachStatusContext(toServiceStatusContext(ctx));
}

function syncProtocolToHud(protocol: { color: string; shortLabel: string }): void {
  setEditorBorderColor(protocol.color);
  setEditorRightLabel(`${protocol.color}⚓ ${protocol.shortLabel}\x1b[0m`);
}

function registerAdmiralSettingsSection(): void {
  const settingsApi = getFleetRuntime().settings.settings;
  settingsApi?.registerSection({
    key: "admiral",
    displayName: "Admiral",
    getDisplayFields() {
      const enabled = isWorldviewEnabled();
      const activeProtocol = getActiveProtocol();
      return [
        { label: "Worldview", value: enabled ? "ON" : "OFF", color: enabled ? "accent" : "dim" },
        { label: "Protocol", value: activeProtocol.shortLabel, color: "accent" },
      ];
    },
  });
}

function scheduleOperationNameGeneration(ctx: ExtensionContext | undefined, eventPrompt?: string): void {
  if (!ctx?.sessionManager) return;

  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionId || OPERATION_NAME_ATTEMPTS.has(sessionId)) return;

  const prompt = eventPrompt?.trim() || extractFirstUserPrompt(ctx);
  if (!prompt) return;

  OPERATION_NAME_ATTEMPTS.add(sessionId);
  syncOperationNameSession(sessionId, true);

  void generateOperationName(ctx, sessionId, prompt);
}

async function generateOperationName(ctx: ExtensionContext, sessionId: string, preparedPrompt: string): Promise<void> {
  const worldviewEnabled = isWorldviewEnabled();
  const model = resolveOperationNameModel(ctx);
  if (!model) {
    syncOperationNameSession(sessionId, false);
    return;
  }

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    if (!auth.apiKey && !auth.headers && ctx.modelRegistry.isUsingOAuth(model)) {
      throw new Error(`OAuth credentials unavailable for ${model.provider}/${model.id}`);
    }

    const settings = loadOperationNameSettings();
    const composed = composeOperationNameRequest({ worldviewEnabled, preparedPrompt });
    const response = await completeSimple(
      model,
      {
        systemPrompt: composed.systemPrompt,
        messages: composed.messages.map((message) => ({ ...message, timestamp: Date.now() })),
      },
      {
        ...(auth.apiKey && { apiKey: auth.apiKey }),
        ...(auth.headers && { headers: auth.headers }),
        ...(settings.reasoning && settings.reasoning !== "off" && { reasoning: settings.reasoning as ThinkingLevel }),
      },
    );

    if (response.stopReason === "aborted") {
      syncOperationNameSession(sessionId, false);
      return;
    }

    const raw = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const displayName = sanitizeOperationNameDisplay(raw, worldviewEnabled);
    if (!isCurrentOperationNameSession(ctx, sessionId)) return;
    syncOperationNameSession(sessionId, false, displayName ?? undefined);
  } catch (error) {
    getLogAPI().debug(
      "metaphor-operation",
      `operation name generation failed: ${error instanceof Error ? error.message : String(error)}`,
      { hideFromFooter: true },
    );
    syncOperationNameSession(sessionId, false);
  }
}

function extractFirstUserPrompt(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
  for (const entry of entries as any[]) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = extractMessageText(entry.message);
    if (text) return text;
  }
  return null;
}

function extractMessageText(message: any): string | null {
  if (typeof message?.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message?.content)) return null;

  const text = message.content
    .map((part: any) => typeof part?.text === "string" ? part.text : "")
    .join("\n")
    .trim();
  return text || null;
}

function resolveOperationNameModel(ctx: ExtensionContext): Model<Api> | null {
  const settings = loadOperationNameSettings();
  const model = settings.provider && settings.model
    ? ctx.modelRegistry.find(settings.provider, settings.model)
    : ctx.model;

  if (!model) {
    getLogAPI().debug("metaphor-operation", "operation name model not available", { hideFromFooter: true });
    return null;
  }

  return model;
}

function syncOperationNameSession(sessionId: string, pending = false, displayName?: string): void {
  const store = readOperationNameStore();
  const current = store.sessions[sessionId];
  const nextDisplayName = displayName ?? current?.displayName;
  store.currentSessionId = sessionId;
  store.sessions[sessionId] = {
    displayName: nextDisplayName,
    pending,
  };
  operationNameStore = store;
  setEditorTopRightLabel(!pending && nextDisplayName ? nextDisplayName : null);
  requestHudRender();
}

function readOperationNameStore(): OperationNameGlobalStore {
  const current = operationNameStore ?? undefined;
  if (isOperationNameGlobalStore(current)) {
    return current;
  }
  if (isOperationNameGlobalState(current)) {
    return {
      currentSessionId: current.sessionId,
      sessions: {
        [current.sessionId]: {
          displayName: current.displayName,
          pending: current.pending,
        },
      },
    };
  }
  return { sessions: {} };
}

function isOperationNameGlobalStore(value: OperationNameGlobalStore | OperationNameGlobalState | undefined): value is OperationNameGlobalStore {
  return Boolean(value && "sessions" in value && value.sessions);
}

function isOperationNameGlobalState(value: OperationNameGlobalStore | OperationNameGlobalState | undefined): value is OperationNameGlobalState {
  return Boolean(value && "sessionId" in value && value.sessionId);
}

function isCurrentOperationNameSession(ctx: ExtensionContext, sessionId: string): boolean {
  try {
    return ctx.sessionManager.getSessionId() === sessionId;
  } catch {
    return false;
  }
}

function toServiceStatusContext(ctx: PiServiceStatusContextLike): ServiceStatusContextPort {
  return {
    hasUI: ctx.hasUI === true,
    getSessionId() {
      return ctx.sessionManager?.getSessionId?.() ?? null;
    },
    notify(message, level) {
      ctx.ui?.notify?.(message, level);
    },
  };
}

function reconcileRegisteredCarrierModels(): void {
  const cliTypesByCarrier = Object.fromEntries(
    getRegisteredOrder()
      .map((carrierId) => {
        const config = getRegisteredCarrierConfig(carrierId);
        return config ? [carrierId, config.cliType] : null;
      })
      .filter((entry): entry is [string, CliType] => entry !== null),
  );

  if (Object.keys(cliTypesByCarrier).length > 0 && reconcileActiveModelSelections(cliTypesByCarrier)) {
    syncModelConfig();
  }
}

function pruneStaleSquadronIds(): void {
  const registeredSet = new Set(getRegisteredOrder());
  const squadronIds = getSquadronEnabledIds();
  const validSquadronIds = squadronIds.filter((id) => registeredSet.has(id));
  if (validSquadronIds.length !== squadronIds.length) {
    setSquadronEnabledCarriers(validSquadronIds);
    saveSquadronEnabled(validSquadronIds);
  }
}

function syncTaskForceConfiguredCarriers(): void {
  const tfIds = getConfiguredTaskForceCarrierIds(getRegisteredOrder());
  setTaskForceConfiguredCarriers(tfIds);
}

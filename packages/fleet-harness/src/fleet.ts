import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@sbluemin/fleet-coding-agent";
import { attachStatusContext, detachStatusContext, getEffort } from "@sbluemin/fleet-unified-agent";
import type { CliType, ServiceStatusContextPort } from "@sbluemin/fleet-unified-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  admiral,
  createFleetCoreRuntime,
  infra,
  metaphor,
  type FleetCoreRuntimeContext,
} from "@sbluemin/fleet-core";
import { registerDefaultCarrierPersonas } from "@sbluemin/fleet-carriers";
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
  registerSingleCarrier,
  resolveCarrierCliType,
  setOfflineCarriers,
  setSquadronEnabledCarriers,
  setTaskForceConfiguredCarriers,
} from "./tools.js";
import { setEditorBorderColor, setEditorRightLabel, setEditorTopRightLabel } from "./hud/border-bridge.js";
import { getCarrierJobsVerbose, setCarrierJobsVerbose, toggleCarrierJobsVerbose } from "./jobs.js";

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
    getEntries?: () => readonly { type: string; customType?: string; data?: unknown }[];
    appendCustomEntry?: (customType: string, data?: unknown) => string;
    flush?: () => void;
  };
  ui?: {
    notify?: (message: string, level: "info" | "warning") => void;
  };
}

const OPERATION_NAME_ATTEMPTS = new Set<string>();

const {
  buildSystemPrompt,
} = admiral.prompts;
const {
  getActiveProtocol,
  getAllProtocols,
  setActiveProtocol,
} = admiral.protocols;
const {
  bindHostSession,
} = admiral.agent.lifecycle;
const { cleanIdle } = admiral.agent.connections;
const {
  getLastLocalStatesGeneration,
  getLastLocalWriteFingerprint,
  getStatesFilePath,
  readStatesSnapshot,
  getConfiguredTaskForceCarrierIds,
  getConfiguredTaskForceCarrierIdsFromSnapshot,
  loadOfflineCarriers,
  loadSquadronEnabled,
  reconcileActiveModelSelections,
  saveSquadronEnabled,
  seedDefaultModels,
} = admiral.store;
const {
  composeOperationNameRequest,
  loadSettings: loadOperationNameSettings,
  sanitizeOperationNameDisplay,
} = metaphor.operationName;
const { isWorldviewEnabled } = metaphor.worldview;

let fleetRuntime: FleetCoreRuntimeContext | undefined;
let bootConfig: BootConfig | null = null;
let reconciliationScheduled = false;
let statesWatcher: fs.FSWatcher | null = null;
let lastObservedGeneration = 0;
let lastObservedStatesFileMeta: { mtimeMs: number; size: number } | null = null;
let operationNameStore: OperationNameGlobalStore | OperationNameGlobalState | null = null;

export { bootBridge, ensureBridgeKeybinds };

export function registerFleetLifecycle(pi: ExtensionAPI): FleetLifecycleRuntime {
  const enabled = shouldBootFleet();
  if (enabled) {
    bootAdmiral(pi);
    bootstrapFleetState(pi);
    syncModelConfig();
    wireFleetPiEvents(pi);
    bootBridge(pi);
    registerFleetPiCommands(pi);
  }
  registerGrandFleet(pi);
  return { fleetEnabled: enabled };
}

export default function registerBoot(pi: ExtensionAPI): void {
  const role = process.env.PI_GRAND_FLEET_ROLE;
  const dev = process.env.FLEET_HARNESS_DEV === "1";
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
  return infra.dataDir.getFleetDataDir();
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
  admiral.agent.registerFleetCoreDefaultAgentTools();
  scheduleFleetReconciliation();
}

export function scheduleFleetReconciliation(): void {
  if (reconciliationScheduled) return;
  reconciliationScheduled = true;
  setTimeout(() => {
    try {
      reconcileRegisteredCarrierModels();
      ensureStatesWatcher();
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
    infra.log.getLogAPI().debug("acp-system-prompt", fleetPrompt, { category: "acp-system-prompt" });
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
    statesWatcher?.close();
    statesWatcher = null;
    detachAgentPanelUi();
    detachStatusContext();
    await shutdownFleetRuntime();
  });
}

export function registerFleetPiCommands(pi: ExtensionAPI): void {
  pi.registerCommand("fleet:admiral:report", {
    description: "Admiral Completion Report 요청",
    handler: async (_args, ctx) => {
      if (typeof pi.sendUserMessage !== "function") {
        throw new Error("fleet:admiral:report requires PI sendUserMessage support");
      }
      pi.sendUserMessage(admiral.protocols.buildCompletionReportRequestPrompt(), { deliverAs: "followUp" });
      ctx.ui.notify("Completion Report 요청을 Admiral 후속 턴에 전달했습니다.", "info");
    },
  });

  pi.registerCommand("fleet:jobs:settings", {
    description: "Carrier Jobs 설정 (verbose, delivery mode)",
    handler: async (_args, ctx) => {
      const verboseEnabled = getCarrierJobsVerbose();
      const current = getDeliverAs();
      const options = [
        `Verbose 렌더링: ${verboseEnabled ? "ON" : "OFF"}`,
        `Push delivery mode: ${current === "followUp" ? "Follow-up (recommended, default)" : "Steer (advanced)"}`,
      ];

      const choice = await ctx.ui.select("Carrier Jobs 설정:", options);
      if (choice === undefined) return;

      if (choice.startsWith("Verbose")) {
        const enabled = toggleCarrierJobsVerbose();
        ctx.ui.notify(`Carrier Jobs verbose: ${enabled ? "ON" : "OFF"}`, "info");
      } else if (choice.startsWith("Push delivery")) {
        const modeChoice = await ctx.ui.select(
          "Push delivery mode:",
          [
            "Follow-up (recommended, default)",
            "Steer (advanced)",
          ],
        );
        if (modeChoice === undefined) return;
        const result = modeChoice.startsWith("Follow") ? "followUp" : "steer";
        await setDeliverAs(result);
        ctx.ui.notify(`Push delivery mode: ${result === "followUp" ? "Follow-up (recommended, default)" : "Steer (advanced)"}`, "info");
      }
    },
  });
}

function bootAdmiral(pi: ExtensionAPI): void {
  const bootProtocol = getActiveProtocol();
  syncProtocolToHud(bootProtocol);
  registerAdmiralSettingsSection();
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

function bindFleetHostSession(ctx: ExtensionContext): void {
  const sessionId = ctx.sessionManager.getSessionId();
  bindHostSession(sessionId, ctx.sessionManager);
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
  const settingsApi = getFleetRuntime().infra.settings.getSettingsService();
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
    const reasoning = resolveOperationNameReasoning(model, settings.reasoning);
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
        ...(reasoning && { reasoning }),
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
    infra.log.getLogAPI().debug(
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
    infra.log.getLogAPI().debug("metaphor-operation", "operation name model not available", { hideFromFooter: true });
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

function resolveOperationNameReasoning(
  model: Model<Api>,
  reasoning: string | undefined,
): ThinkingLevel | undefined {
  if (!reasoning || reasoning === "off") return undefined;
  const parsed = admiral.agent.models.parseModelId(model.id, model.provider);
  if (!parsed) return undefined;
  const modelEffort = getModelEffort(parsed.cli, parsed.backendModel);
  return modelEffort.supported && modelEffort.levels?.includes(reasoning)
    ? reasoning as ThinkingLevel
    : undefined;
}

function getModelEffort(cli: CliType, modelId: string): ReturnType<typeof getEffort> {
  return getEffort(cli, modelId);
}

function reconcileRegisteredCarrierModels(): void {
  const cliTypesByCarrier = Object.fromEntries(
    getRegisteredOrder()
      .map((carrierId) => {
        const config = getRegisteredCarrierConfig(carrierId);
        return config ? [carrierId, resolveCarrierCliType(carrierId, config.defaultCliType)] : null;
      })
      .filter((entry): entry is [string, CliType] => entry !== null),
  );

  // states.json에 모델 엔트리가 없는 캐리어에 대해 소스레벨 defaultModel로 시딩
  const defaultsByCarrier = Object.fromEntries(
    getRegisteredOrder()
      .map((carrierId) => {
        const config = getRegisteredCarrierConfig(carrierId);
        return config
          ? [carrierId, { cliType: resolveCarrierCliType(carrierId, config.defaultCliType), defaultModel: config.defaultModel, defaultEffort: config.defaultEffort }]
          : null;
      })
      .filter((entry): entry is [string, { cliType: CliType; defaultModel: string | undefined; defaultEffort: string | undefined }] => entry !== null),
  );
  const seeded = seedDefaultModels(defaultsByCarrier);

  const reconciled = Object.keys(cliTypesByCarrier).length > 0
    && reconcileActiveModelSelections(cliTypesByCarrier);

  if (seeded || reconciled) {
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

function ensureStatesWatcher(): void {
  if (statesWatcher) return;
  const filePath = getStatesFilePath();
  if (!filePath) return;
  const dirPath = path.dirname(filePath);
  const filename = path.basename(filePath);
  statesWatcher = fs.watch(dirPath, (_event: string, changed: string | null) => {
    if (changed && changed !== filename) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    const fileMeta = { mtimeMs: stat.mtimeMs, size: stat.size };
    const snapshot = readStatesSnapshot();
    const generation = snapshot.generation;

    if (generation > 0) {
      const metaMatchesLastObserved =
        lastObservedStatesFileMeta !== null
        && lastObservedStatesFileMeta.mtimeMs === fileMeta.mtimeMs
        && lastObservedStatesFileMeta.size === fileMeta.size;

      // generation만 같고 mtime/size가 바뀐 경우(외부가 _generation 유지하며 내용만 변경) reload 누락 방지
      if (generation === lastObservedGeneration && metaMatchesLastObserved) {
        return;
      }

      const isOurWriteGeneration = generation === getLastLocalStatesGeneration();
      const localFp = getLastLocalWriteFingerprint();
      const eventMatchesLocalWriteFingerprint =
        localFp !== null
        && generation === localFp.generation
        && fileMeta.mtimeMs === localFp.mtimeMs
        && fileMeta.size === localFp.size;

      // writeStates 직후 stat한 지문과 일치할 때만 최초 echo 억제(mtime 정밀도 한계는 size와 병합)
      if (eventMatchesLocalWriteFingerprint && generation !== lastObservedGeneration) {
        lastObservedGeneration = generation;
        lastObservedStatesFileMeta = fileMeta;
        return;
      }

      if (isOurWriteGeneration && metaMatchesLastObserved) {
        // 동일 generation + 동일 파일 메타의 중복 이벤트 — echo 억제
        return;
      }

      if (isOurWriteGeneration) {
        // generation 번호는 우리 것과 같지만 파일 메타가 달라진 경우: 외부 편집 등으로 reload
        lastObservedGeneration = generation;
        lastObservedStatesFileMeta = fileMeta;
        reconcileRegisteredCarrierModels();
        setTaskForceConfiguredCarriers(
          getConfiguredTaskForceCarrierIdsFromSnapshot(snapshot, getRegisteredOrder()),
        );
        syncModelConfig();
        notifyStatusUpdate();
        return;
      }

      lastObservedGeneration = generation;
      lastObservedStatesFileMeta = fileMeta;
      reconcileRegisteredCarrierModels();
      setTaskForceConfiguredCarriers(
        getConfiguredTaskForceCarrierIdsFromSnapshot(snapshot, getRegisteredOrder()),
      );
      syncModelConfig();
      notifyStatusUpdate();
      return;
    }

    if (
      lastObservedStatesFileMeta
      && lastObservedStatesFileMeta.mtimeMs === fileMeta.mtimeMs
      && lastObservedStatesFileMeta.size === fileMeta.size
    ) {
      return;
    }
    lastObservedStatesFileMeta = fileMeta;
    reconcileRegisteredCarrierModels();
    const snap = readStatesSnapshot();
    setTaskForceConfiguredCarriers(
      getConfiguredTaskForceCarrierIdsFromSnapshot(snap, getRegisteredOrder()),
    );
    syncModelConfig();
    notifyStatusUpdate();
  });
}

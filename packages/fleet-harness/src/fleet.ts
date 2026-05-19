import type { ExtensionAPI, ExtensionContext } from "@sbluemin/fleet-coding-agent";
import { attachStatusContext, detachStatusContext } from "@sbluemin/fleet-unified-agent";
import type { CliType, ServiceStatusContextPort } from "@sbluemin/fleet-unified-agent";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  admiral,
  createFleetCoreRuntime,
  infra,
  type FleetCoreRuntimeContext,
} from "@sbluemin/fleet-core";
import { registerDefaultCarrierPersonas } from "@sbluemin/fleet-carriers";
import { bootBridge, ensureBridgeKeybinds } from "./bridge/handler.js";
import { syncModelConfig } from "./panel/config.js";
import { registerGrandFleet } from "./grand-fleet/index.js";
import { getKeybindAPI } from "./keybinds.js";
import { detachAgentPanelUi, refreshAgentPanel } from "./panel/ui.js";
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
import { setEditorBorderColor, setEditorRightLabel } from "./hud/border-bridge.js";
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
let fleetRuntime: FleetCoreRuntimeContext | undefined;
let bootConfig: BootConfig | null = null;
let reconciliationScheduled = false;
let statesWatcher: fs.FSWatcher | null = null;
let lastObservedGeneration = 0;
let lastObservedStatesFileMeta: { mtimeMs: number; size: number } | null = null;

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
  pi.on("before_agent_start", () => {
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
      const activeProtocol = getActiveProtocol();
      return [
        { label: "Protocol", value: activeProtocol.shortLabel, color: "accent" },
      ];
    },
  });
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

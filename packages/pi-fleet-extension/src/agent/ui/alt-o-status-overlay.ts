import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  getProviderModels,
  getReasoningEffortLevels,
  getServiceSnapshots,
  refreshStatusQuiet,
} from "@sbluemin/unified-agent";
import type { CliType, ProviderModelInfo } from "@sbluemin/unified-agent";

import { getKeybindAPI } from "../../shell/keybinds/bridge.js";
import { refreshAgentPanel } from "./panel-lifecycle.js";
import {
  disableSortieCarrier,
  disableSquadronCarrier,
  enableSortieCarrier,
  enableSquadronCarrier,
  getRegisteredCarrierConfig,
  getRegisteredOrder,
  getSortieDisabledIds,
  getSquadronEnabledIds,
  isSortieCarrierEnabled,
  isSquadronCarrierEnabled,
  notifyStatusUpdate,
  resolveCarrierDisplayName,
  setTaskForceConfiguredCarriers,
  updateCarrierCliType,
} from "../../tool-registry.js";
import {
  getConfiguredTaskForceBackends,
  getConfiguredTaskForceCarrierIds,
  getPerCliSettings,
  getTaskForceModelConfig,
  loadModels as getModelConfig,
  resetTaskForceModelSelection,
  savePerCliSettings,
  saveSortieDisabled,
  saveSquadronEnabled,
  updateCliTypeOverride,
  updateModelSelection,
  updateTaskForceModelSelection,
} from "@sbluemin/fleet-core/admiral/store";
import { syncModelConfig } from "./panel/config.js";
import { TASKFORCE_CLI_TYPES, type TaskForceCliType } from "@sbluemin/fleet-core/admiral/taskforce";
import { CarrierStatusOverlay } from "./carrier-ui/status-overlay.js";
import { StatusOverlayController } from "@sbluemin/fleet-core/admiral/carrier/status-overlay-controller";
import { TaskForceConfigOverlay } from "./carrier-ui/taskforce-config-overlay.js";
import type {
  CarrierCliType,
  CarrierStatusEntry,
  CliModelInfo,
  ModelSelection as OverlayModelSelection,
} from "@sbluemin/fleet-core/admiral/carrier/types";

let activeStatusPopup: Promise<void> | null = null;
let dismissStatusPopup: (() => void) | null = null;

export function registerCarrierStatusKeybind(_pi: ExtensionAPI): void {
  const keybind = getKeybindAPI();
  keybind.register({
    extension: "fleet",
    action: "carrier-status",
    defaultKey: "alt+o",
    description: "캐리어 함대 현황 오버레이",
    category: "Fleet Bridge",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      if (activeStatusPopup) {
        dismissStatusPopup?.();
        return;
      }

      const entries = buildStatusEntries();
      activeStatusPopup = ctx.ui.custom(
        (tui: any, theme: any, _keybindings: any, done: () => void) => {
          dismissStatusPopup = done;
          const overlayController = createStatusOverlayController(entries, () => refreshAgentPanel(ctx));

          return new CarrierStatusOverlay(
            tui,
            theme,
            entries,
            {
              getEntries: () => entries,
              changeCliType: (carrierId: string, newCliType: CarrierCliType) => {
                return overlayController.changeCliType(carrierId, newCliType);
              },
              changeCliTypes: async (updates: Array<{ carrierId: string; newCliType: CarrierCliType }>) => {
                return overlayController.changeCliTypes(updates);
              },
              resetCliTypesToDefault: async () => {
                return overlayController.resetCliTypesToDefault();
              },
              saveModelSelection: async (carrierId: string, selection: OverlayModelSelection) => {
                await updateModelSelection(carrierId, selection);
                handleModelUpdated();
              },
              toggleSortieEnabled,
              toggleSquadronEnabled: (carrierId: string) => {
                toggleSquadronEnabled(carrierId);
                refreshAgentPanel(ctx);
              },
              getAvailableModels: getCliModelInfo,
              getServiceSnapshots: () =>
                new Map(
                  getServiceSnapshots().map((snapshot) => [
                    snapshot.provider as CarrierCliType,
                    { status: snapshot.status },
                  ]),
                ),
              getDefaultCliType: () => "claude",
              openTaskForce: (carrierId: string) => {
                openTaskForceOverlay(carrierId, ctx);
              },
            },
            done,
          );
        },
        {
          overlay: true,
          overlayOptions: {
            width: "70%",
            maxHeight: "60%",
            anchor: "center",
            margin: 1,
          },
        },
      );

      try {
        refreshStatusQuiet();
        await activeStatusPopup;
      } finally {
        activeStatusPopup = null;
        dismissStatusPopup = null;
      }
    },
  });
}

function buildStatusEntries(): CarrierStatusEntry[] {
  const modelConfig = getModelConfig();
  const entries: CarrierStatusEntry[] = [];

  for (const id of getRegisteredOrder()) {
    const config = getRegisteredCarrierConfig(id);
    if (!config) continue;

    const cliType = config.cliType;
    const selection = modelConfig[id];
    const provider = getProviderModels(cliType);
    const meta = config.carrierMetadata;

    entries.push({
      carrierId: id,
      slot: config.slot,
      cliType,
      defaultCliType: config.defaultCliType as CarrierCliType,
      displayName: resolveCarrierDisplayName(id),
      model: selection?.model || provider.defaultModel,
      isDefault: !selection?.model,
      effort: selection?.effort ?? null,
      role: meta?.title ?? null,
      roleDescription: meta ? `${meta.title} — ${meta.summary}` : null,
      isSortieEnabled: isSortieCarrierEnabled(id),
      isSquadronEnabled: isSquadronCarrierEnabled(id),
      taskForceBackendCount: getConfiguredTaskForceBackends(id).length,
      category: meta?.category,
    });
  }

  return entries;
}

function createStatusOverlayController(
  entries: CarrierStatusEntry[],
  refreshPanel: () => void,
): StatusOverlayController {
  return new StatusOverlayController({
    getEntries: () => entries,
    getRegisteredOrder,
    getRegisteredCarrierConfig: (carrierId: string) => getRegisteredCarrierConfig(carrierId),
    getCurrentModelSelection: (carrierId: string) => getModelConfig()[carrierId],
    getAvailableModels: getCliModelInfo,
    getPerCliSettings: (carrierId: string, cliType: CarrierCliType) => getPerCliSettings(carrierId, cliType),
    savePerCliSettings: (carrierId: string, cliType: CarrierCliType, selection) => {
      savePerCliSettings(carrierId, cliType, selection);
    },
    updateCarrierCliType: (carrierId: string, cliType: CarrierCliType) => {
      updateCarrierCliType(carrierId, cliType as CliType);
    },
    updateModelSelection: async (carrierId: string, selection) => {
      await updateModelSelection(carrierId, selection);
    },
    refreshAgentPanel: refreshPanel,
    syncModelConfig,
    notifyStatusUpdate,
    updateCliTypeOverride: (carrierId, cliType, defaultCliType) => {
      updateCliTypeOverride(carrierId, cliType, defaultCliType);
    },
  });
}

function getCliModelInfo(cliType: CarrierCliType): CliModelInfo {
  return getProviderModels(cliType as CliType) as ProviderModelInfo;
}

function handleModelUpdated(): void {
  syncModelConfig();
  notifyStatusUpdate();
}

function toggleSortieEnabled(carrierId: string): void {
  if (isSortieCarrierEnabled(carrierId)) {
    disableSortieCarrier(carrierId);
  } else {
    enableSortieCarrier(carrierId);
  }
  saveSortieDisabled(getSortieDisabledIds());
  notifyStatusUpdate();
}

function toggleSquadronEnabled(carrierId: string): void {
  if (isSquadronCarrierEnabled(carrierId)) {
    disableSquadronCarrier(carrierId);
  } else {
    enableSquadronCarrier(carrierId);
  }
  const registeredSet = new Set(getRegisteredOrder());
  saveSquadronEnabled(getSquadronEnabledIds().filter((id) => registeredSet.has(id)));
  notifyStatusUpdate();
}

function openTaskForceOverlay(carrierId: string, ctx: Parameters<Parameters<ReturnType<typeof getKeybindAPI>["register"]>[0]["handler"]>[0]): void {
  dismissStatusPopup?.();
  const carrierConfig = getRegisteredCarrierConfig(carrierId);
  if (!carrierConfig) {
    ctx.ui.notify(`등록되지 않은 carrier입니다: ${JSON.stringify(carrierId)}`, "error");
    return;
  }

  const carrierDisplayName = carrierConfig?.displayName ?? carrierId;
  const tfCallbacks = {
    getAvailableModels: (cliType: string) => getProviderModels(requireTaskForceCliType(cliType)),
    getEffortLevels: (cliType: string) => getReasoningEffortLevels(requireTaskForceCliType(cliType)),
    getBackendConfig: (cliType: string) => {
      const resolvedCliType = requireTaskForceCliType(cliType);
      const tfConfig = getTaskForceModelConfig(carrierId, resolvedCliType);
      const modelConfigNow = getModelConfig();
      const isCustom = !!(modelConfigNow[carrierId]?.taskforce?.[resolvedCliType]);
      const provider = getProviderModels(resolvedCliType);
      return {
        model: tfConfig?.model ?? provider.defaultModel,
        effort: tfConfig?.effort ?? null,
        isCustom,
      };
    },
    updateBackendConfig: async (cliType: string, selection: { model: string; effort?: string }) => {
      updateTaskForceModelSelection(
        carrierId,
        requireTaskForceCliType(cliType),
        selection,
      );
      syncConfiguredTaskForceCarriers();
    },
    resetBackendConfig: (cliType: string) => {
      resetTaskForceModelSelection(carrierId, requireTaskForceCliType(cliType));
      syncConfiguredTaskForceCarriers();
    },
  };

  void ctx.ui.custom(
    (tui2: any, theme2: any, _kb2: any, done2: () => void) =>
      new TaskForceConfigOverlay(tui2, theme2, carrierId, carrierDisplayName, tfCallbacks, done2),
    {
      overlay: true,
      overlayOptions: { width: "60%", maxHeight: "55%", anchor: "center", margin: 1 },
    },
  );
}

function requireTaskForceCliType(cliType: string): TaskForceCliType {
  const allowedTaskForceCliTypes = new Set<string>(TASKFORCE_CLI_TYPES);
  if (!allowedTaskForceCliTypes.has(cliType)) {
    throw new Error(`Unsupported Task Force backend: ${cliType}`);
  }
  return cliType as TaskForceCliType;
}

function syncConfiguredTaskForceCarriers(): void {
  const tfIds = getConfiguredTaskForceCarrierIds(getRegisteredOrder());
  setTaskForceConfiguredCarriers(tfIds);
  notifyStatusUpdate();
}

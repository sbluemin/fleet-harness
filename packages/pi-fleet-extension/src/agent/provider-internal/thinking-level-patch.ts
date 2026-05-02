import { AgentSession, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getProviderModels } from "@sbluemin/unified-agent";
import type { Model } from "../provider.js";

import { isFleetProviderId, parseModelId, parseProviderId } from "./state.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

type PatchableModel = Pick<Model<any>, "id" | "provider" | "reasoning">;
export type UiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type PatchableAgentSession = InstanceType<typeof AgentSession> & {
  getAvailableThinkingLevels(): UiThinkingLevel[];
  supportsXhighThinking(): boolean;
  model?: PatchableModel;
};

type PatchedThinkingLevelFn = (() => unknown) & {
  __fleetAcpThinkingLevelPatched?: boolean;
};

type OriginalGetAvailableThinkingLevels = (this: PatchableAgentSession) => UiThinkingLevel[];
type OriginalSupportsXhighThinking = (this: PatchableAgentSession) => boolean;

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const THINKING_LEVEL_ORDER: UiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ACP_UI_LEVELS = new Set<UiThinkingLevel>(["low", "medium", "high", "xhigh"]);

let acpThinkingLevelPatchInstalled = false;

export function installAcpThinkingLevelPatch(): void {
  if (acpThinkingLevelPatchInstalled) {
    return;
  }

  const prototype = AgentSession.prototype as PatchableAgentSession;
  const originalGetAvailableThinkingLevels: OriginalGetAvailableThinkingLevels = prototype.getAvailableThinkingLevels;
  const originalSupportsXhighThinking: OriginalSupportsXhighThinking = prototype.supportsXhighThinking;
  if (isPatchedThinkingLevelFn(originalGetAvailableThinkingLevels) || isPatchedThinkingLevelFn(originalSupportsXhighThinking)) {
    acpThinkingLevelPatchInstalled = true;
    return;
  }

  const getAvailableThinkingLevelsPatched: PatchedThinkingLevelFn = function getAvailableThinkingLevelsPatched(this: PatchableAgentSession): UiThinkingLevel[] {
    const override = getAcpAvailableThinkingLevels(this.model);
    return override ?? Reflect.apply(originalGetAvailableThinkingLevels, this, []) as UiThinkingLevel[];
  };
  getAvailableThinkingLevelsPatched.__fleetAcpThinkingLevelPatched = true;
  prototype.getAvailableThinkingLevels = getAvailableThinkingLevelsPatched as PatchableAgentSession["getAvailableThinkingLevels"];

  const supportsXhighThinkingPatched: PatchedThinkingLevelFn = function supportsXhighThinkingPatched(this: PatchableAgentSession): boolean {
    const override = getAcpAvailableThinkingLevels(this.model);
    if (override) {
      return override.includes("xhigh");
    }
    return Reflect.apply(originalSupportsXhighThinking, this, []) as boolean;
  };
  supportsXhighThinkingPatched.__fleetAcpThinkingLevelPatched = true;
  prototype.supportsXhighThinking = supportsXhighThinkingPatched as PatchableAgentSession["supportsXhighThinking"];

  acpThinkingLevelPatchInstalled = true;
}

export function reconcileAcpThinkingLevel(
  pi: Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel">,
  model: PatchableModel | undefined,
): void {
  const availableLevels = getAcpAvailableThinkingLevels(model);
  if (!availableLevels) {
    return;
  }

  const currentLevel = pi.getThinkingLevel() as UiThinkingLevel;
  const nextLevel = availableLevels.includes(currentLevel)
    ? currentLevel
    : clampThinkingLevel(currentLevel, availableLevels);

  if (nextLevel !== currentLevel) {
    pi.setThinkingLevel(nextLevel);
  }
}

export function getAcpAvailableThinkingLevels(
  model: PatchableModel | undefined,
): UiThinkingLevel[] | null {
  if (!model || !isFleetProviderId(model.provider) || !model.reasoning) {
    return null;
  }

  const cli = parseProviderId(model.provider) ?? parseModelId(model.id, model.provider)?.cli;
  if (!cli) {
    return null;
  }

  const provider = getProviderModels(cli);
  if (!provider?.reasoningEffort.supported) {
    return ["off"];
  }

  const levels = provider.reasoningEffort.levels.filter(
    (level): level is UiThinkingLevel => ACP_UI_LEVELS.has(level as UiThinkingLevel),
  );

  return ["off", ...levels];
}

export function clampThinkingLevel(
  level: UiThinkingLevel,
  availableLevels: UiThinkingLevel[],
): UiThinkingLevel {
  const available = new Set(availableLevels);
  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level);

  if (requestedIndex === -1) {
    return availableLevels[0] ?? "off";
  }

  for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i++) {
    const candidate = THINKING_LEVEL_ORDER[i];
    if (available.has(candidate)) {
      return candidate;
    }
  }

  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = THINKING_LEVEL_ORDER[i];
    if (available.has(candidate)) {
      return candidate;
    }
  }

  return availableLevels[0] ?? "off";
}

function isPatchedThinkingLevelFn(value: unknown): value is PatchedThinkingLevelFn {
  return typeof value === "function" && (value as PatchedThinkingLevelFn).__fleetAcpThinkingLevelPatched === true;
}

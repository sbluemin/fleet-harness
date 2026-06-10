import { CLI_DISPLAY_NAMES } from "@dotobokuri/fleet-carriers";
import { getCliEffortLevels, getCliModels } from "@dotobokuri/core-agent";

import type { CarrierCliType, CliModelInfo, ModelEffort } from "./types.js";

/** core-agent 모델 조회를 carrier-roster의 CliModelInfo로 변환하는 단일 어댑터. */
export function getAvailableModels(cliType: CarrierCliType): CliModelInfo {
  const name = CLI_DISPLAY_NAMES[cliType] ?? cliType;
  try {
    const models = getCliModels(cliType).map((model) => ({
      modelId: model.id,
      name: model.name,
    }));
    const defaultModel = models[0]?.modelId ?? "default";
    return {
      defaultModel,
      effort: getModelEffort(cliType, defaultModel),
      models,
      name,
    };
  } catch {
    return {
      defaultModel: "default",
      effort: { supported: false },
      models: [],
      name,
    };
  }
}

/** CLI/모델 기준 effort 정보를 조회한다. 미지원·조회 실패 시 supported=false. */
export function getModelEffort(cliType: CarrierCliType, modelId: string): ModelEffort {
  try {
    const levels = getCliEffortLevels(cliType, modelId);
    if (!levels || levels.length === 0) return { supported: false };
    return {
      default: levels[0],
      levels,
      supported: true,
    };
  } catch {
    return { supported: false };
  }
}

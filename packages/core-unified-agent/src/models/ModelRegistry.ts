/**
 * 정적 모델 레지스트리
 * models.json에서 빌드 시 인라인된 데이터를 검증하여 제공합니다.
 */

import modelsData from '../../models.json' with { type: 'json' };
import { ModelsRegistrySchema } from './schemas.js';
import type {
  ModelEntry,
  ModelsMapping,
  ModelsRegistry,
  ProviderModelInfo,
  Effort,
} from './schemas.js';
import type { CliType } from '../config/CliConfigs.js';

// 빌드 시 인라인, 한 번만 검증 후 동결
const registry: ModelsRegistry = Object.freeze(ModelsRegistrySchema.parse(modelsData));

/**
 * 전체 모델 레지스트리의 복사본을 반환합니다.
 */
export function getModelsRegistry(): ModelsRegistry {
  return structuredClone(registry);
}

/**
 * 특정 CLI(프로바이더)의 모델 정보를 반환합니다.
 * 내부 데이터 보호를 위해 복사본을 반환합니다.
 *
 * @param cli - CLI 타입 (claude, codex, opencode-go, cursor)
 * @returns 프로바이더 모델 정보
 * @throws 존재하지 않는 프로바이더인 경우
 */
export function getProviderModels(cli: CliType): ProviderModelInfo {
  const provider = registry.providers[cli];
  if (!provider) {
    throw new Error(`알 수 없는 프로바이더: "${cli}"`);
  }
  return structuredClone(provider);
}

/**
 * 특정 CLI의 사용 가능한 모델 ID 목록을 반환합니다.
 *
 * @param cli - CLI 타입
 * @returns 모델 ID 배열
 */
export function getProviderModelIds(cli: CliType): string[] {
  return getProviderModels(cli).models.map((m) => m.modelId);
}

/**
 * 특정 CLI/모델의 effort 설정을 반환합니다.
 *
 * @param cli - CLI 타입
 * @param modelId - 모델 ID
 * @returns effort 설정
 * @throws 존재하지 않는 모델인 경우
 */
export function getEffort(cli: CliType, modelId: string): Effort {
  const model = findProviderModel(cli, modelId);
  return structuredClone(model.effort);
}

/**
 * Cursor 모델의 spawn-time effort 적용 가능 여부를 반환합니다.
 *
 * @param modelId - 카탈로그 모델 ID
 * @returns spawn template과 effort 지원 정보
 */
export function getCursorSpawnEffortInfo(modelId: string): {
  supported: boolean;
  levels: string[];
  default: string | null;
} {
  const model = findProviderModel('cursor', modelId);
  if (!model.spawnModelTemplate || !model.effort.supported) {
    return { supported: false, levels: [], default: null };
  }

  return {
    supported: true,
    levels: [...model.effort.levels],
    default: model.effort.default,
  };
}

/**
 * Cursor 모델을 cursor-agent CLI에 전달할 실제 모델 ID로 변환합니다.
 *
 * @param modelId - 카탈로그 모델 ID
 * @param effort - 요청된 effort (없으면 모델 기본값)
 * @returns cursor-agent CLI 모델 ID
 */
export function resolveCursorSpawnModel(modelId: string, effort?: string): string {
  const model = findProviderModel('cursor', modelId);
  if (!model.spawnModelTemplate) {
    return model.modelId;
  }

  if (!model.effort.supported) {
    return model.spawnModelTemplate;
  }

  const level = effort ?? model.effort.default;
  const resolvedLevel = model.effort.levels.includes(level) ? level : model.effort.default;
  if (!model.effort.levels.includes(resolvedLevel)) {
    throw new Error(
      `cursor/${modelId} 모델은 effort "${level}"을(를) 지원하지 않습니다. 사용 가능: ${model.effort.levels.join(', ')}`,
    );
  }

  return model.spawnModelTemplate.replace('{effort}', resolvedLevel);
}

/**
 * 특정 CLI/모델의 effort 레벨 목록을 반환합니다.
 *
 * @param cli - CLI 타입
 * @param modelId - 모델 ID
 * @returns 레벨 배열 (미지원 시 null)
 */
export function getEffortLevels(cli: CliType, modelId: string): string[] | null {
  const effort = getEffort(cli, modelId);
  if (!effort.supported) {
    return null;
  }
  return effort.levels;
}

/**
 * 특정 CLI(프로바이더)의 modelsMapping을 반환합니다.
 *
 * @param cli - CLI 타입
 * @returns modelsMapping (없으면 null)
 */
export function getProviderModelsMapping(cli: CliType): ModelsMapping | null {
  const provider = registry.providers[cli];
  if (!provider) {
    throw new Error(`알 수 없는 프로바이더: "${cli}"`);
  }
  return provider.modelsMapping ? structuredClone(provider.modelsMapping) : null;
}

function findProviderModel(cli: CliType, modelId: string): ModelEntry {
  const provider = registry.providers[cli];
  if (!provider) {
    throw new Error(`알 수 없는 프로바이더: "${cli}"`);
  }

  const model = provider.models.find((m) => m.modelId === modelId);
  if (!model) {
    throw new Error(`알 수 없는 모델: "${cli}/${modelId}"`);
  }
  return model;
}

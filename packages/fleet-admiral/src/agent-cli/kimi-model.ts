/**
 * Kimi(claude-kimi) 프로바이더 기본 모델 선택 해석
 * 전역 설정(~/.fleet/settings.json의 kimiModel)과 레지스트리 기본값을 병합해
 * claude-kimi 실행 env에 주입할 모델/effort를 결정합니다.
 */

import {
  getEffort,
  getEffortLevels,
  getModelContextWindow,
  getProviderModelIds,
  getProviderModels,
} from "@dotobokuri/core-unified-agent";

export interface KimiModelSelection {
  readonly model: string;
  readonly effort?: string;
}

interface KimiGlobalOptionsLike {
  load(): { kimiModel?: { model?: unknown; effort?: unknown } };
}

/**
 * 전역 설정에 저장된 Kimi 기본 모델 선택을 해석합니다.
 * 저장값이 없거나 유효하지 않으면 레지스트리 defaultModel(및 모델 기본 effort)로 폴백합니다.
 */
export function resolveKimiModelSelection(
  globalOptionsService?: KimiGlobalOptionsLike,
): KimiModelSelection {
  let stored: { model?: unknown; effort?: unknown } | undefined;
  try {
    stored = globalOptionsService?.load().kimiModel;
  } catch {
    stored = undefined;
  }
  return resolveKimiModelSelectionFromOverride(
    typeof stored?.model === "string" ? stored.model : undefined,
    typeof stored?.effort === "string" ? stored.effort : undefined,
  );
}

/**
 * 명시적 모델/effort 오버라이드를 레지스트리 기준으로 검증해 선택을 조립합니다.
 * 모델이 유효하지 않으면 레지스트리 defaultModel로, effort가 미지원/무효하면 모델 기본값으로 폴백합니다.
 */
export function resolveKimiModelSelectionFromOverride(
  model?: string,
  effort?: string,
): KimiModelSelection {
  const validIds = getProviderModelIds("claude-kimi");
  const resolvedModel = model && validIds.includes(model)
    ? model
    : getProviderModels("claude-kimi").defaultModel;

  const levels = getEffortLevels("claude-kimi", resolvedModel);
  if (!levels) {
    return { model: resolvedModel };
  }
  const effortConfig = getEffort("claude-kimi", resolvedModel);
  const resolvedEffort = effort && levels.includes(effort)
    ? effort
    : (effortConfig.supported ? effortConfig.default : undefined);
  return resolvedEffort
    ? { model: resolvedModel, effort: resolvedEffort }
    : { model: resolvedModel };
}

/**
 * Kimi 모델 선택을 Claude Code 실행 env로 변환합니다.
 * 공식 문서 기준으로 전 모델 슬롯을 선택 모델로 고정하고,
 * 모델의 컨텍스트 윈도우에 맞춰 auto-compact/max-context 토큰을 설정합니다.
 */
export function buildKimiModelEnv(selection: KimiModelSelection): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_MODEL: selection.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: selection.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: selection.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: selection.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: selection.model,
    CLAUDE_CODE_SUBAGENT_MODEL: selection.model,
  };
  const contextWindow = getModelContextWindow("claude-kimi", selection.model);
  if (contextWindow !== null) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow);
  }
  if (selection.effort) {
    env.CLAUDE_CODE_EFFORT_LEVEL = selection.effort;
  }
  return env;
}

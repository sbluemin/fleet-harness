/**
 * directive-refinement/settings.ts — 설정 파일 관리
 *
 * core-settings API를 통해 ~/.fleet/settings.json의 "metaphor-directive-refinement" 섹션에서 읽고 쓴다.
 */

import type { ReasoningLevel } from "./constants.js";
import type { CoreSettingsAPI } from "../../infra/settings/index.js";
import { getSettingsService } from "../../infra/settings/runtime.js";

export interface DirectiveRefinementSettings {
  /** 모델 프로바이더 (미설정 시 세션 모델 사용) */
  provider?: string;
  /** 모델 ID */
  model?: string;
  /** Reasoning 레벨 (off / low / medium / high) */
  reasoning?: ReasoningLevel;
}

export const SECTION_KEY = "metaphor-directive-refinement";
const LEGACY_TEMP_SECTION_KEY = "metaphor-refine-directive";
const LEGACY_SECTION_KEY = "core-improve-prompt";

/** 설정 로드 */
export function loadSettings(): DirectiveRefinementSettings {
  try {
    const api = getAPI();
    const current = api.load<DirectiveRefinementSettings>(SECTION_KEY);
    if (hasSettings(current)) return current;

    const legacyTemp = api.load<DirectiveRefinementSettings>(LEGACY_TEMP_SECTION_KEY);
    if (hasSettings(legacyTemp)) return legacyTemp;

    const legacy = api.load<DirectiveRefinementSettings>(LEGACY_SECTION_KEY);
    if (hasSettings(legacy)) return legacy;

    return current ?? {};
  } catch {
    return {};
  }
}

/** 설정 저장 */
export function saveSettings(settings: DirectiveRefinementSettings): void {
  getAPI().save(SECTION_KEY, settings);
}

function hasSettings(settings: DirectiveRefinementSettings | undefined): boolean {
  if (!settings) return false;
  return Boolean(settings.provider || settings.model || settings.reasoning);
}

function getAPI(): CoreSettingsAPI {
  const api = getSettingsService();
  if (!api) throw new Error("Settings API not available");
  return api;
}

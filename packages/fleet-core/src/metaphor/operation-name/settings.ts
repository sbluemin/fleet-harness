/**
 * operation-name/settings.ts — 설정 파일 관리
 *
 * core-settings API를 통해 ~/.fleet/settings.json의 "metaphor-operation-name" 섹션에서 읽고 쓴다.
 */

import type { ReasoningLevel } from "./constants.js";
import type { CoreSettingsAPI } from "../../services/settings/index.js";
import { getSettingsService } from "../../services/settings/runtime.js";

export interface OperationNameSettings {
  /** 모델 프로바이더 (미설정 시 세션 모델 사용) */
  provider?: string;
  /** 모델 ID */
  model?: string;
  /** Reasoning 레벨 (off / low / medium / high) */
  reasoning?: ReasoningLevel;
}

export const SECTION_KEY = "metaphor-operation-name";

/** 설정 로드 */
export function loadSettings(): OperationNameSettings {
  try {
    return getAPI().load<OperationNameSettings>(SECTION_KEY);
  } catch {
    return {};
  }
}

/** 설정 저장 */
export function saveSettings(settings: OperationNameSettings): void {
  getAPI().save(SECTION_KEY, settings);
}

function getAPI(): CoreSettingsAPI {
  const api = getSettingsService();
  if (!api) throw new Error("Settings API not available");
  return api;
}

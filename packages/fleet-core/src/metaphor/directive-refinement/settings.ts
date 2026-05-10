/**
 * directive-refinement/settings.ts — 설정 파일 관리
 *
 * core-settings API를 통해 ~/.fleet/settings.json의 "metaphor-directive-refinement" 섹션에서 읽고 쓴다.
 */

import type { CliType } from "@sbluemin/fleet-unified-agent";
import type { CoreSettingsAPI } from "../../infra/settings/index.js";
import { getSettingsService } from "../../infra/settings/runtime.js";

export interface DirectiveRefinementSettings {
  /** CLI 백엔드 ID (claude, codex, gemini 등) */
  cliType?: CliType;
  /** 모델 ID */
  model?: string;
  /** Reasoning effort 레벨 */
  effort?: string;
}

export const SECTION_KEY = "metaphor-directive-refinement";

/** 설정 로드 */
export function loadSettings(): DirectiveRefinementSettings {
  try {
    return getAPI().load<DirectiveRefinementSettings>(SECTION_KEY) ?? {};
  } catch {
    return {};
  }
}

/** 설정 저장 */
export function saveSettings(settings: DirectiveRefinementSettings): void {
  getAPI().save(SECTION_KEY, settings);
}

function getAPI(): CoreSettingsAPI {
  const api = getSettingsService();
  if (!api) throw new Error("Settings API not available");
  return api;
}

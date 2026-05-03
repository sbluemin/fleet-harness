import { getSettingsService } from "../infra/settings/runtime.js";

import { WORLDVIEW_SETTINGS_KEY, type MetaphorSettings } from "./prompts.js";

/**
 * metaphor worldview 활성 여부를 반환한다.
 *
 * settings API가 없거나 값이 비어 있으면 비활성(false)로 간주한다.
 */
export function isWorldviewEnabled(): boolean {
  const api = getSettingsService();
  if (!api) return false;
  const cfg = api.load<MetaphorSettings>(WORLDVIEW_SETTINGS_KEY);
  return cfg.worldview === true;
}

/**
 * metaphor worldview 설정을 저장한다.
 *
 * 기존 settings 값을 유지하면서 worldview 플래그만 갱신한다.
 */
export function setWorldviewEnabled(enabled: boolean): void {
  const api = getSettingsService();
  if (!api) return;
  const cfg = api.load<MetaphorSettings>(WORLDVIEW_SETTINGS_KEY);
  api.save(WORLDVIEW_SETTINGS_KEY, { ...cfg, worldview: enabled });
}

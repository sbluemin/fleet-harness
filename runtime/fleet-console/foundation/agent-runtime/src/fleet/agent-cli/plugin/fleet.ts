import { FLEET_PLUGIN_NAME } from "../types.js";
import type { AssetPluginBundle } from "../types.js";

export const assetBundle: AssetPluginBundle = {
  description: "Fleet gateway identities and lifecycle hooks",
  directoryName: "fleet-gateway",
  displayName: "Fleet",
  name: FLEET_PLUGIN_NAME,
  source: "asset",
};

/** zip에 들어갈 파일 하나. relativePath는 `/` 구분의 플러그인 루트 상대 경로다. */
export interface AssetPluginFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * 플러그인의 전체 파일 집합을 메모리에서 조립한다. 디스크에는 아무것도 쓰지 않는다 —
 * 호스트가 이 목록을 기동에 한 번 zip으로 묶어 루프백으로 내준다.
 *
 * 훅과 에이전트 등록은 여기 없다. 그것들은 SDK 세션의 `hooks`·`agents` 옵션이 소유하며,
 * 이 패키지는 더 이상 훅 스크립트나 함수 훅 모듈을 렌더하지 않는다 — 이벤트마다 외부
 * 프로세스를 세우던 경로가 그 이전과 함께 사라졌다.
 */
export function buildAssetPluginFiles(
  bundle: AssetPluginBundle,
  _options: unknown,
  version: string,
): readonly AssetPluginFile[] {
  return [{ relativePath: ".claude-plugin/plugin.json", content: toJsonContent(claudeManifest(bundle, version)) }];
}

function toJsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function claudeManifest(bundle: AssetPluginBundle, version: string): unknown {
  return {
    name: bundle.name,
    version,
    description: bundle.description,
  };
}

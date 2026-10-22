import fs from "node:fs";
import path from "node:path";

/**
 * 폐기한 내장 플러그인의 id. 그 플러그인이 `pluginDataDir(id)`에 남긴 것은 Fleet이 만든 것뿐이다
 * (Skills: 내려받은 skills CLI와 그 npm 트리). 이제 아무도 읽지 않으므로 기동 때 걷는다.
 */
const RETIRED_PLUGIN_IDS = ["skills"] as const;

/**
 * 폐기한 내장 플러그인의 데이터 폴더(`<Console 데이터>/plugins/<id>`)만 지운다. 걷은 뒤에는 폴더가
 * 없으므로 다음 기동부터는 아무 일도 하지 않는다. best-effort이며 어떤 실패도 기동을 막지 않는다.
 *
 * 삭제 경계:
 * - 이 Console이 같은 id의 플러그인을 발견했으면(사용자가 설치한 외부 플러그인, apiVersion으로 거절된 것 포함)
 *   그 폴더는 그 플러그인의 것이므로 건드리지 않는다.
 * - `plugins` 자체가 실제 디렉터리가 아니면(심링크 등) 아무것도 지우지 않는다 — 데이터 루트 밖을 지울 수 있다.
 * - 대상이 심링크면 링크만 지워지고 가리키는 곳은 남는다(`fs.rmSync`는 따라가지 않는다).
 * - 사용자 스킬(`~/.claude/skills`, 프로젝트 `.claude/skills`)은 이 경로 밖이라 닿지 않는다.
 */
export function reclaimRetiredPluginData(
  consoleDataDir: string,
  activePluginIds: ReadonlySet<string>,
  warn: (message: string) => void = console.warn,
): void {
  const pluginsRoot = path.join(consoleDataDir, "plugins");
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(pluginsRoot);
  } catch {
    return;
  }
  if (!rootStat.isDirectory()) return;
  for (const id of RETIRED_PLUGIN_IDS) {
    if (activePluginIds.has(id)) continue;
    const target = path.join(pluginsRoot, id);
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      warn(`[fleet-console] Retired plugin data ${id} not removed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

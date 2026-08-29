import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const consoleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = path.resolve(consoleRoot, "../fleet-plugins");

/**
 * 빌트인 플러그인의 서버 라우트가 게시 산출물까지 따라오는지 지키는 자리.
 *
 * plugin-host는 소스 체크아웃에서는 `<plugin>/routes.ts`를 직접 찾아 esbuild로 번들한다.
 * 게시 설치본에는 그 소스가 없으므로 `dist/fleet-plugins/<id>/routes.mjs`만 본다 — 그 파일은
 * tsup 엔트리에 적힌 플러그인에 대해서만 만들어진다. 두 목록이 어긋나면 소스에서는 모든
 * 것이 동작하고 게시본에서만 그 플러그인의 라우트가 통째로 사라진다.
 *
 * 실제로 Codex가 코어에서 플러그인으로 옮겨 갈 때 이 엔트리가 빠졌고, 테스트·빌드·E2E가
 * 전부 소스에서 돌아 초록인 채로 1.77.0이 나갔다. 사용자는 위키가 열리지 않는 것으로 그것을
 * 처음 알았다. 목록 대조는 사람이 기억할 일이 아니라 여기서 할 일이다.
 */
function readTsupPluginRouteEntries(): ReadonlySet<string> {
  const source = fs.readFileSync(path.join(consoleRoot, "tsup.config.ts"), "utf8");
  const ids = new Set<string>();
  for (const match of source.matchAll(/"fleet-plugins\/([a-z0-9][a-z0-9-]*)\/routes"/gu)) {
    ids.add(match[1]!);
  }
  return ids;
}

function readPluginsWithServerRoutes(): readonly string[] {
  return fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(pluginsRoot, entry.name, "routes.ts")))
    .map((entry) => entry.name)
    .sort();
}

describe("built-in plugin route bundles", () => {
  it("builds a published route bundle for every plugin that serves routes", () => {
    const declared = readTsupPluginRouteEntries();
    const withRoutes = readPluginsWithServerRoutes();

    expect(withRoutes.length).toBeGreaterThan(0);
    const missing = withRoutes.filter((id) => !declared.has(id));
    expect(missing, `tsup.config.ts is missing a "fleet-plugins/<id>/routes" entry for: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no route bundle for a plugin that has no routes.ts", () => {
    const declared = [...readTsupPluginRouteEntries()].sort();
    const withRoutes = new Set(readPluginsWithServerRoutes());

    // 반대 방향도 지킨다 — 사라진 플러그인의 엔트리가 남으면 빌드가 그 자리에서 깨진다.
    const stale = declared.filter((id) => !withRoutes.has(id));
    expect(stale, `tsup.config.ts declares a route bundle for a plugin without routes.ts: ${stale.join(", ")}`).toEqual([]);
  });
});

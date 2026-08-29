import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 빌트인 플러그인의 매니페스트를 게시 산출물로 옮기는 자리.
 *
 * plugin-host는 소스 체크아웃에서 `runtime/fleet-plugins/<id>/plugin.json`을 읽지만, 게시
 * 설치본에는 그 파일이 없어 디렉터리 이름만으로 `{ id, routes }`짜리 매니페스트를 **지어낸다**.
 * 지어낸 매니페스트에는 `consoleRoutePrefix`와 `sensitiveFields`가 없다.
 *
 * 그 두 필드는 장식이 아니다. `consoleRoutePrefix`가 없으면 `/console/<prefix>` 등록이 스코프
 * 검사에 걸려 plugin_route_outside_scope로 **콘솔 부팅 자체가 실패**하고, `sensitiveFields`가
 * 없으면 그 플러그인이 추가로 가리라고 선언한 필드가 브라우저 DTO로 나간다(고정 목록 밖의
 * 것만 해당한다).
 *
 * 그래서 산출물에 진짜 매니페스트를 함께 내보낸다. `routes`만 빌드된 이름으로 바꾼다 —
 * 소스는 `routes.ts`를 가리키지만 게시본에 있는 것은 tsup이 낸 `routes.mjs`다. `client`는
 * 빼는데, 클라이언트는 vite 번들에 흡수되어 이 디렉터리에 존재하지 않기 때문이다.
 */
const DIST_ROUTES_FILE = "routes.mjs";

/** 산출물 매니페스트로 옮길 값. 소스 매니페스트에서 의미를 지닌 필드만 추린다. */
export function createPluginDistManifest(sourceManifest) {
  const manifest = { id: sourceManifest.id, routes: DIST_ROUTES_FILE };
  if (typeof sourceManifest.apiVersion === "number") manifest.apiVersion = sourceManifest.apiVersion;
  if (typeof sourceManifest.name === "string") manifest.name = sourceManifest.name;
  if (typeof sourceManifest.consoleRoutePrefix === "string") manifest.consoleRoutePrefix = sourceManifest.consoleRoutePrefix;
  if (Array.isArray(sourceManifest.sensitiveFields)) {
    manifest.sensitiveFields = sourceManifest.sensitiveFields.filter((field) => typeof field === "string");
  }
  return manifest;
}

/**
 * 라우트를 서빙하는 빌트인 플러그인 목록. `routes.ts`의 존재가 곧 "서버 라우트가 있다"는
 * 사실이므로, tsup 엔트리 목록이 아니라 소스에서 읽는다 — 엔트리를 빠뜨린 것이야말로
 * 이 검사가 잡아야 할 결함이다.
 */
export function readBuiltInPluginsWithRoutes(pluginsRoot) {
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(pluginsRoot, entry.name, "routes.ts")))
    .map((entry) => entry.name)
    .sort();
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const pluginsRoot = path.join(repoRoot, "runtime", "fleet-plugins");
  const distRoot = path.join(repoRoot, "runtime", "fleet-console", "dist", "fleet-plugins");

  const missingBundles = [];
  let written = 0;

  for (const id of readBuiltInPluginsWithRoutes(pluginsRoot)) {
    const distPluginDir = path.join(distRoot, id);
    if (!existsSync(path.join(distPluginDir, DIST_ROUTES_FILE))) {
      missingBundles.push(id);
      continue;
    }
    const sourceManifestPath = path.join(pluginsRoot, id, "plugin.json");
    if (!existsSync(sourceManifestPath)) {
      throw new Error(`[generate:plugin-dist-manifests] ${id}: routes.ts는 있는데 plugin.json이 없습니다.`);
    }
    const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
    writeFileSync(
      path.join(distPluginDir, "plugin.json"),
      `${JSON.stringify(createPluginDistManifest(sourceManifest), null, 2)}\n`,
      "utf8",
    );
    written += 1;
  }

  if (missingBundles.length > 0) {
    // 소스에서는 plugin-host가 routes.ts를 직접 번들하므로 테스트도 E2E도 초록으로 지나간다.
    // 게시본에서만 그 플러그인의 라우트가 통째로 사라지므로, 판정은 산출물에서 내린다.
    throw new Error(
      `[generate:plugin-dist-manifests] 다음 플러그인의 라우트 번들이 없습니다: ${missingBundles.join(", ")}\n` +
        `runtime/fleet-console/tsup.config.ts의 entry에 "fleet-plugins/<id>/routes"를 추가하세요.`,
    );
  }

  console.log(`[generate:plugin-dist-manifests] ${written}개 플러그인 매니페스트 기록`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

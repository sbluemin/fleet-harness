import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { buildApiCatalog } from "../core/host/api-catalog.js";

const SERVER_SOURCE = fs.readFileSync(new URL("../core/host/server.ts", import.meta.url), "utf8");

/**
 * 카탈로그는 백엔드 API 표면의 선언이고 설정 화면이 그대로 보여준다. 코어 디스패치가
 * 라우트를 추가하면서 선언을 빠뜨리면 표면은 조용히 넓어지고 게이트도 기록되지 않는다.
 * 그래서 디스패치가 아는 경로를 카탈로그가 모두 아는지 반대 방향으로도 고정한다.
 *
 * 예외는 선언 자체가 틀린 경우에만 둔다.
 * - `/api/v1/environment`: local 채널에서만 응답하고 그 외 채널에서는 404다(server.ts의
 *   handleEnvironmentDiagnostics). 발행 카탈로그가 이 경로를 선언하면 대부분의 설치에서
 *   존재하지 않는 라우트를 광고하게 되므로 의도적으로 비워 둔다.
 */
const UNDECLARED_BY_DESIGN = new Set(["/api/v1/environment"]);

describe("api catalog coverage", () => {
  const catalogPaths = buildApiCatalog().map((entry) => entry.path);

  it("declares every api path the core dispatch compares against", () => {
    const dispatched = collectMatches(/pathname === "(\/api\/[^"]+)"/g).filter((route) => !UNDECLARED_BY_DESIGN.has(route));

    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.filter((route) => !catalogPaths.includes(route))).toEqual([]);
  });

  it("declares at least one route under every api prefix the core dispatch registers", () => {
    const prefixes = collectMatches(/routeRegistry\.register\("(\/api\/[^"]+)"/g);
    const undeclared = prefixes.filter((prefix) => !catalogPaths.some((route) => route === prefix || route.startsWith(`${prefix}/`)));

    expect(prefixes.length).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });

  it("keeps the exemption lists honest", () => {
    // 죽은 예외는 다음 누락을 가린다 — 더 이상 디스패치되지 않거나 이미 선언됐으면 목록에서 지운다.
    for (const route of UNDECLARED_BY_DESIGN) {
      expect(SERVER_SOURCE, `${route} is exempt but no longer dispatched`).toContain(`pathname === "${route}"`);
      expect(catalogPaths, `${route} is exempt but now declared`).not.toContain(route);
    }
  });
});

function collectMatches(pattern: RegExp): string[] {
  return [...new Set([...SERVER_SOURCE.matchAll(pattern)].map((match) => match[1]!))].sort();
}

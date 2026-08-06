import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// AI Gateway 설정의 저장 축은 core-ai-gateway가 소유하고, 이 플러그인은 **경로만** 넘긴다.
// 그 주입이 빠져도 코드는 컴파일되고 테스트도 전부 통과한다 — core가 실제 홈(`~/.fleet`)으로
// 조용히 폴백하기 때문이다. 그러면 격리 루트로 띄운 Console이 사용자의 진짜 설정을 읽고
// 덮어쓰는데, 관측 가능한 실패가 하나도 없다. 그래서 배선 자체를 소스 계약으로 고정한다.
const ROUTES_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "routes.ts"),
  "utf-8",
);

describe("ai gateway settings store wiring", () => {
  it("injects the host's effective Fleet data root instead of letting core fall back to the real home", () => {
    const construction = ROUTES_SOURCE.match(/createAiGatewaySettingsStore\(\{[^}]*\}\)/s);
    expect(construction).not.toBeNull();
    expect(construction![0]).toContain("dataDir: ctx.host.paths.fleetDataDir");
  });

  it("hands core the plugin data directory as the only adoption source", () => {
    const construction = ROUTES_SOURCE.match(/createAiGatewaySettingsStore\(\{[^}]*\}\)/s);
    // 승계 여부는 이 인자의 유무가 결정한다. 호스트가 경로 판단을 하지 않는다는 계약이기도 하다.
    expect(construction![0]).toContain("legacyDir: ctx.host.paths.pluginDataDir(ctx.pluginId)");
  });

  it("keeps every AI Gateway settings decision out of this plugin", () => {
    // 정규화·검증·카탈로그 투영·선별 해석은 core-ai-gateway 소유다. 플러그인이 자기 사본을
    // 다시 들면 두 벌이 갈라진다.
    expect(ROUTES_SOURCE).not.toContain("./server/ai-gateway-settings.js");
    expect(ROUTES_SOURCE).toContain("createAiGatewaySettingsStore");
    expect(ROUTES_SOURCE).toContain("@dotobokuri/core-ai-gateway");
  });
});

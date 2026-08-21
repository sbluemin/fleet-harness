import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildPanelGatewayCommand } from "../server/agent-api/launch.js";
import { createPanelGatewayPool, type PanelGatewayPool } from "../server/panel-gateway-pool.js";

/**
 * 실제 자식 프로세스를 띄워 풀 전체를 통과시키는 검사.
 *
 * 가짜 자식으로는 결코 드러나지 않는 이음매를 잰다: 커맨드 해석이 실제 번들을 가리키는지,
 * 그 번들이 정말 뜨는지, 풀이 돌려준 URL이 진짜 서빙하는지. Console 번들이 필요하므로
 * 빌드가 없는 환경에서는 건너뛴다.
 */
const CONSOLE_DIST = fileURLToPath(new URL("../../../fleet-console/dist/", import.meta.url));
const CONSOLE_ENTRY = path.join(CONSOLE_DIST, "cli.mjs");
const HAS_BUILD = fs.existsSync(path.join(CONSOLE_DIST, "panel-gateway.mjs"));
const TIMEOUT_MS = 40_000;

let pool: PanelGatewayPool | undefined;
const dirs: string[] = [];

afterEach(() => {
  pool?.dispose();
  pool = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createPool(): PanelGatewayPool {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-pgw-live-"));
  dirs.push(dataDir);
  return createPanelGatewayPool({
    enabled: () => true,
    command: () => buildPanelGatewayCommand({ entryPath: CONSOLE_ENTRY }),
    env: { ...process.env, FLEET_DATA_DIR: dataDir },
  });
}

describe.skipIf(!HAS_BUILD)("panel gateway pool over real processes", () => {
  it("resolves the slim bundle beside the console entry", () => {
    const command = buildPanelGatewayCommand({ entryPath: CONSOLE_ENTRY });

    // 전용 번들이 있으면 그것을 단독 실행한다 — Console 전체를 다시 적재하지 않는다.
    expect(command.args).toEqual([path.join(CONSOLE_DIST, "panel-gateway.mjs")]);
  });

  it("falls back to the console entry when the slim bundle is missing", () => {
    const command = buildPanelGatewayCommand({ entryPath: CONSOLE_ENTRY }, () => false);

    expect(command.args).toEqual([CONSOLE_ENTRY, "panel-gateway"]);
  });

  it("hands a panel a URL that its own gateway answers", async () => {
    pool = createPool();

    const baseUrl = await pool.claim("op-live-1");
    expect(baseUrl).not.toBeNull();

    // 마운트 경로까지 포함해 그대로 다이얼한다. 여기서 테스트가 경로를 덧붙이면 URL이 불완전해도
    // green이 되고, 실제로 그렇게 해서 모든 모델 요청이 404인 결함을 놓쳤다.
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ai-gateway$/u);
    const response = await fetch(`${baseUrl}/api/hello`);
    expect(response.status).toBe(200);
  }, TIMEOUT_MS);

  it("serves a messages request at exactly the path a client appends", async () => {
    pool = createPool();
    const baseUrl = await pool.claim("op-live-1");

    // Claude Code가 baseUrl 뒤에 붙이는 그 경로다. 401은 라우터가 거기 있다는 뜻이고,
    // 404였다면 이 패널의 모든 턴이 죽는다는 뜻이다.
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-gateway--xai--grok-4.6", messages: [] }),
    });

    expect(response.status).toBe(401);
  }, TIMEOUT_MS);

  it("gives two panels two gateways that both answer", async () => {
    pool = createPool();

    const [first, second] = await Promise.all([pool.claim("op-live-1"), pool.claim("op-live-2")]);

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    const statuses = await Promise.all([first, second].map(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/hello`);
      return response.status;
    }));
    expect(statuses).toEqual([200, 200]);
  }, TIMEOUT_MS);

  it("stops answering once the panel is released", async () => {
    pool = createPool();
    const baseUrl = await pool.claim("op-live-1");
    expect((await fetch(`${baseUrl}/api/hello`)).status).toBe(200);

    pool.release("op-live-1");
    await new Promise((resolve) => { setTimeout(resolve, 500); });

    // 회수는 포트를 실제로 놓아야 한다 — 안 그러면 Console이 사는 동안 포트가 새어 나간다.
    await expect(fetch(`${baseUrl}/api/hello`)).rejects.toThrow();
  }, TIMEOUT_MS);
});

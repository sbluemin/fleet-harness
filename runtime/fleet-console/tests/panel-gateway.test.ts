import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { PANEL_GATEWAY_READY_PREFIX, PANEL_GATEWAY_ROUTE_PATH } from "../core/host/panel-gateway.js";

/**
 * 자식은 게시본이 실제로 실행하는 진입점, 즉 번들된 `dist/cli.mjs`로 띄운다.
 *
 * TS 소스를 tsx로 띄우는 길은 막혀 있다: 워크스페이스 패키지의 `exports`가 `types`를 먼저
 * 두므로 bare tsx가 `dist/index.d.ts`를 런타임 모듈로 집어 든다. 부모 프로세스는 vitest의
 * alias 덕에 그 문제를 만나지 않지만 spawn된 자식에게는 그 alias가 없다. 게시 경로와 같은
 * 것을 재는 편이 더 정확하기도 하다.
 */
const SLIM_ENTRY = fileURLToPath(new URL("../dist/panel-gateway.mjs", import.meta.url));
const CLI_ENTRY = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const HAS_BUILD = fs.existsSync(SLIM_ENTRY) && fs.existsSync(CLI_ENTRY);
const START_TIMEOUT_MS = 30_000;

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.stdin?.end();
    child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function startPanelGateway(
  args: readonly string[] = [SLIM_ENTRY],
): { readonly child: ChildProcess; readonly ready: Promise<string> } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-panel-gw-"));
  dirs.push(dataDir);
  const child = spawn(process.execPath, [...args], {
    env: { ...process.env, FLEET_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const ready = new Promise<string>((resolve, reject) => {
    let buffered = "";
    let stderr = "";
    const timer = setTimeout(() => { reject(new Error(`panel gateway never reported a port. stderr=${stderr}`)); }, START_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const at = buffered.indexOf(PANEL_GATEWAY_READY_PREFIX);
      if (at < 0) return;
      const rest = buffered.slice(at + PANEL_GATEWAY_READY_PREFIX.length);
      const end = rest.search(/[\r\n]/u);
      if (end < 0) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${rest.slice(0, end).trim()}`);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`panel gateway exited early with ${code}. stderr=${stderr}`)); });
  });
  return { child, ready };
}

describe.skipIf(!HAS_BUILD)("panel gateway process", () => {
  it("listens on its own port and serves the gateway there", async () => {
    const { ready } = startPanelGateway();
    const origin = await ready;

    const hello = await fetch(`${origin}${PANEL_GATEWAY_ROUTE_PATH}/api/hello`);

    expect(hello.status).toBe(200);
  }, START_TIMEOUT_MS + 10_000);

  it("refuses a messages request that carries no Anthropic credential", async () => {
    const { ready } = startPanelGateway();
    const origin = await ready;

    const response = await fetch(`${origin}${PANEL_GATEWAY_ROUTE_PATH}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-gateway--xai--grok-4.6", messages: [] }),
    });

    // 게이트웨이 라우터가 실제로 마운트되어 자기 자격 게이트를 적용했다는 증거다.
    expect(response.status).toBe(401);
  }, START_TIMEOUT_MS + 10_000);

  it("answers nothing outside its mounted route", async () => {
    const { ready } = startPanelGateway();
    const origin = await ready;

    const response = await fetch(`${origin}/v1/messages`, { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
  }, START_TIMEOUT_MS + 10_000);

  it("gives two panels two different ports", async () => {
    const first = startPanelGateway();
    const second = startPanelGateway();

    const [a, b] = await Promise.all([first.ready, second.ready]);

    expect(a).not.toBe(b);
  }, START_TIMEOUT_MS + 10_000);

  it("serves the same gateway through the console entry fallback", async () => {
    // 전용 번들이 없는 환경에서 쓰는 폴백 경로다. 더 무겁지만 같은 것을 서빙해야 한다.
    const { ready } = startPanelGateway([CLI_ENTRY, "panel-gateway"]);
    const origin = await ready;

    const hello = await fetch(`${origin}${PANEL_GATEWAY_ROUTE_PATH}/api/hello`);

    expect(hello.status).toBe(200);
  }, START_TIMEOUT_MS + 10_000);

  it("shuts itself down when its parent closes stdin", async () => {
    const { child, ready } = startPanelGateway();
    await ready;

    const exited = new Promise<number | null>((resolve) => { child.once("exit", (code) => { resolve(code); }); });
    child.stdin?.end();

    // 부모가 사라지면 자식도 사라져야 한다 — 아니면 Console이 죽은 뒤에도 포트를 쥔 채 남는다.
    await expect(exited).resolves.toBe(0);
  }, START_TIMEOUT_MS + 10_000);
});

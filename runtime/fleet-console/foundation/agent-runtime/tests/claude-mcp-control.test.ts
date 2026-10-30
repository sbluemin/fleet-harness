import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openClaudeMcpControl } from "../src/claude/mcp-control.js";

/**
 * 사령관 플러그인 인증이 기대는 vendor SDK 의 비공개 제어 요청 계약. 실제 vendor `query()`에 control 프로토콜만 말하는
 * 가짜 CLI 를 물려, SDK 메서드가 어떤 wire 요청을 보내는지와 응답을 어떻게 읽는지를 본다. SDK 를 올렸을 때 메서드가
 * 사라지거나 subtype 이 바뀌면 여기서 깨진다(SDK 0.3.306 기준). 모델·네트워크·보안 저장소는 쓰지 않는다.
 */

const FAKE_CLI = String.raw`
const fs = require("node:fs");
const log = process.env.FAKE_CLI_LOG;
let buffer = "";
const reply = (request_id, response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id, response } }) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type !== "control_request") continue;
    const request = message.request;
    fs.appendFileSync(log, JSON.stringify(request) + "\n");
    if (request.subtype === "initialize") reply(message.request_id, { commands: [], models: [], account: {} });
    else if (request.subtype === "mcp_status") reply(message.request_id, { mcpServers: [
      { name: "plugin:fixture:remote", status: "needs-auth", config: { type: "http", url: "https://mcp.example.test/mcp", headers: { "X-Secret": "never-surfaced" } } },
      { name: "plugin:fixture:other", status: "weird" },
    ] });
    else if (request.subtype === "mcp_authenticate") reply(message.request_id, { authUrl: "https://auth.example.test/authorize?state=s", requiresUserAction: true, callbackExpected: true, redirectScheme: "localhost", state: "s", callbackPort: 1 });
    else reply(message.request_id, {});
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let root: string | null = null;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = null; });

describe("Claude MCP control child", () => {
  it("speaks the private mcp auth control requests through the vendor SDK", async () => {
    root = mkdtempSync(path.join(tmpdir(), "fleet-mcp-control-"));
    const cli = path.join(root, "fake-cli.cjs");
    const log = path.join(root, "requests.jsonl");
    writeFileSync(cli, FAKE_CLI);
    writeFileSync(log, "");
    const spawned: Record<string, string | undefined>[] = [];
    const configs: unknown[] = [];
    const control = openClaudeMcpControl({
      executablePath: cli,
      env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-never", FAKE_CLI_LOG: log },
      configDir: path.join(root, "home"),
      cwd: root,
      credentials: "shared",
      servers: { "plugin:fixture:remote": { type: "ws", url: "wss://mcp.example.test/mcp", headers: { "X-Client": "fleet" }, headersHelper: "node /plugin/headers.cjs" } },
      spawnProcess: (request) => {
        spawned.push({ ...request.env });
        configs.push(JSON.parse(request.args[request.args.indexOf("--mcp-config") + 1]!));
        return spawn(process.execPath, [cli], { cwd: request.cwd, env: { ...request.env }, stdio: ["pipe", "pipe", "pipe"] });
      },
    });
    try {
      // 설정(헤더)과 모르는 상태는 상태 목록에 실리지 않는다.
      expect(await control.status()).toEqual([{ name: "plugin:fixture:remote", status: "needs-auth" }]);
      expect(await control.authenticate("plugin:fixture:remote")).toEqual({ authUrl: "https://auth.example.test/authorize?state=s", requiresUserAction: true, redirectScheme: "localhost" });
      await control.submitCallbackUrl("plugin:fixture:remote", "http://localhost:1/callback?code=c&state=s");
      await control.clearAuth("plugin:fixture:remote");
    } finally { control.close(); }

    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.map((request) => request.subtype)).toEqual(["initialize", "mcp_status", "mcp_authenticate", "mcp_oauth_callback_url", "mcp_clear_auth"]);
    expect(requests[2]).toMatchObject({ serverName: "plugin:fixture:remote" });
    expect(requests[3]).toMatchObject({ serverName: "plugin:fixture:remote", callbackUrl: "http://localhost:1/callback?code=c&state=s" });
    expect(requests[4]).toMatchObject({ serverName: "plugin:fixture:remote" });
    // 원격 전송 방식과 동적 인증 명령도 실제 CLI 인자로 보존한다. 헬퍼를 이 프로세스에서 실행하지 않는다.
    expect(configs).toEqual([{ mcpServers: { "plugin:fixture:remote": { type: "ws", url: "wss://mcp.example.test/mcp", headers: { "X-Client": "fleet" }, headersHelper: "node /plugin/headers.cjs" } } }]);
    // 기본 보안 저장소 항목을 쓰고, 모델 자격은 싣지 않는다.
    expect(spawned[0]).toMatchObject({ CLAUDE_CONFIG_DIR: path.join(root, "home"), CLAUDE_SECURESTORAGE_CONFIG_DIR: "" });
    expect(spawned[0]?.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

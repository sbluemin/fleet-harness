import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createStandaloneCliLaunchResolver } from "../../features/execution/host/standalone-cli/launch.js";
import { chatChildEnv, stripConsoleInternalEnv } from "../../features/execution/host/terminal/launch-env.js";

describe("stripConsoleInternalEnv", () => {
  it("removes desktop protocol markers and internal hints while keeping hook-required keys", () => {
    const env = stripConsoleInternalEnv({
      PATH: "/usr/bin",
      FLEET_CONSOLE_OWNER_ID: "desktop-owner-1",
      FLEET_CONSOLE_OWNER_KIND: "desktop",
      FLEET_CONSOLE_PROTOCOL_VERSION: "1",
      FLEET_CONSOLE_RESOURCE_ROOT: "/apps/fleet/resources",
      FLEET_CONSOLE_DESKTOP_DEVELOPMENT: "1",
      FLEET_CONSOLE_DESKTOP_VERSION: "1.23.0",
      FLEET_CONSOLE_PACKAGE_ROOT: "/apps/fleet/resources/sidecar/fleet-console",
      FLEET_CONSOLE_DIR: "/Users/op/.fleet/console",
      FLEET_CONSOLE_SESSION_ID: "session-1",
    });
    expect(env.PATH).toBe("/usr/bin");
    // capture hook은 FLEET_CONSOLE_DIR로 콘솔 데이터 디렉터리를 찾는다 — 유지 필수.
    expect(env.FLEET_CONSOLE_DIR).toBe("/Users/op/.fleet/console");
    expect(env.FLEET_CONSOLE_SESSION_ID).toBe("session-1");
    expect(env.FLEET_CONSOLE_OWNER_ID).toBeUndefined();
    expect(env.FLEET_CONSOLE_OWNER_KIND).toBeUndefined();
    expect(env.FLEET_CONSOLE_PROTOCOL_VERSION).toBeUndefined();
    expect(env.FLEET_CONSOLE_RESOURCE_ROOT).toBeUndefined();
    expect(env.FLEET_CONSOLE_DESKTOP_DEVELOPMENT).toBeUndefined();
    expect(env.FLEET_CONSOLE_DESKTOP_VERSION).toBeUndefined();
    expect(env.FLEET_CONSOLE_PACKAGE_ROOT).toBeUndefined();
  });

  it("does not mutate the source environment", () => {
    const source: NodeJS.ProcessEnv = { FLEET_CONSOLE_OWNER_KIND: "desktop" };
    stripConsoleInternalEnv(source);
    expect(source.FLEET_CONSOLE_OWNER_KIND).toBe("desktop");
  });
});

describe("chatChildEnv", () => {
  it("drops the inherited session id and turns Artifact on for the SDK child", () => {
    const env = chatChildEnv({
      PATH: "/usr/bin",
      FLEET_CONSOLE_SESSION_ID: "terminal-session-1",
      FLEET_CONSOLE_WORKSPACE_SESSION_ID: "terminal-session-1",
      FLEET_CONSOLE_WORKSPACE_RUN_ID: "old-run",
      FLEET_CONSOLE_DIR: "/Users/op/.fleet/console",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FLEET_CONSOLE_DIR).toBe("/Users/op/.fleet/console");
    // 상속된 터미널 세션 id를 따라가면 이 자식의 훅이 남의 세션 축에 보고한다.
    expect(env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
    expect(env.FLEET_CONSOLE_WORKSPACE_SESSION_ID).toBeUndefined();
    expect(env.FLEET_CONSOLE_WORKSPACE_RUN_ID).toBeUndefined();
    // SDK 진입점의 기본값은 Artifact 비활성이고, 그러면 도구와 함께 artifact-* 스킬 셋이
    // 자식의 목록에서 사라져 컴포저 덱에도 서지 못한다.
    expect(env.CLAUDE_CODE_ARTIFACT).toBe("1");
  });

  it("keeps an operator's explicit Artifact choice", () => {
    expect(chatChildEnv({ CLAUDE_CODE_ARTIFACT: "0" }).CLAUDE_CODE_ARTIFACT).toBe("0");
  });

  it("does not mutate the source environment", () => {
    const source: NodeJS.ProcessEnv = { FLEET_CONSOLE_SESSION_ID: "terminal-session-1" };
    chatChildEnv(source);
    expect(source.FLEET_CONSOLE_SESSION_ID).toBe("terminal-session-1");
    expect(source.CLAUDE_CODE_ARTIFACT).toBeUndefined();
  });
});

describe("standalone Claude Code CLI launch", () => {
  it("launches plain claude toward the Gateway without Fleet MCP, plugins, prompts, or inherited session credentials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-standalone-cli-"));
    try {
      const bin = path.join(root, "claude");
      fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
      const home = path.join(root, "home");
      const theater = path.join(root, "theater");
      const launch = createStandaloneCliLaunchResolver({
        env: {
          PATH: "/usr/bin",
          HOME: home,
          CLAUDE_BIN: bin,
          // Console 이 다른 Claude·Fleet 세션 안에서 떴을 때 상속하는 표식과 자격.
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "parent-session",
          CLAUDE_CODE_SESSION_ACCESS_TOKEN: "parent-session-access",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
          CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
          FLEET_CONSOLE_SESSION_ID: "objective-1",
          FLEET_MOD_TOKEN: "mod-token",
          FLEET_COMPACT_HOOK_TOKEN: "compact-token",
          FLEET_CONSOLE_OWNER_KIND: "desktop",
          // 이 env는 settings보다 우선하므로 Fleet 자식에서는 지운다.
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
        },
        aiGateway: { routePath: "/api/v1/ai-gateway", origin: () => "http://127.0.0.1:4100" },
        homeDir: home,
      });
      const spec = await launch(theater, { sessionId: "standalone-cli", objectiveRecordType: "standalone-cli" });

      expect(spec.bin).toBe(bin);
      // Fleet MCP·플러그인·프롬프트·세션 좌표는 없다. 인자는 압축 창 --settings와 승인 우회 플래그뿐이다.
      expect(spec.args.filter((arg) => arg !== "--settings" && !arg.startsWith("{"))).toEqual(["--dangerously-skip-permissions"]);
      const settings = JSON.parse(spec.args[spec.args.indexOf("--settings") + 1] ?? "{}") as {
        modelSettings: Record<string, { autoCompactWindow: number }>;
      };
      // 카탈로그 500_000 × Auto(창−16_000) + 33_000.
      expect(settings.modelSettings["claude-gateway--codex--gpt-6.2-sol[1m]"]?.autoCompactWindow).toBe(517_000);
      expect(spec.cwd).toBe(theater);
      expect(spec.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4100/api/v1/ai-gateway");
      expect(spec.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
      expect(spec.env.HOME).toBe(home);
      for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "FLEET_CONSOLE_SESSION_ID", "FLEET_MOD_TOKEN", "FLEET_MOD_BASE_URL", "FLEET_COMPACT_HOOK_TOKEN", "FLEET_COMPACT_BASE_URL", "FLEET_CONSOLE_OWNER_KIND", "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"]) {
        expect(spec.env[key], key).toBeUndefined();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects fleet-browser MCP into both Claude Code and Antigravity CLI without putting bearer tokens in argv, and cleans up on exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-standalone-cli-mcp-"));
    try {
      const claudeBin = path.join(root, "claude");
      const agyBin = path.join(root, "agy");
      fs.writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(agyBin, "#!/bin/sh\n", { mode: 0o755 });
      const home = path.join(root, "home");
      const theater = path.join(root, "theater");
      const preparedCalls: Array<{ cli: string; cwd: string; commodoreId: string | null }> = [];
      let releases = 0;
      const browserMcp = {
        prepare: async (options: { readonly cli: "claude" | "antigravity"; readonly cwd: string; readonly commodoreId: string | null }) => {
          preparedCalls.push({ cli: options.cli, cwd: options.cwd, commodoreId: options.commodoreId });
          return {
            endpointUrl: "http://127.0.0.1:4199/mcp/fleet-browser",
            bearerToken: `tok-${options.cli}-secret`,
            release: async () => { releases += 1; },
          };
        },
      };
      const baseDeps = {
        env: { PATH: "/usr/bin", HOME: home, CLAUDE_BIN: claudeBin, AGY_BIN: agyBin, FLEET_CONSOLE_SESSION_ID: "parent" },
        aiGateway: { routePath: "/api/v1/ai-gateway", origin: () => "http://127.0.0.1:4100" },
        browserMcp,
        homeDir: home,
      };

      const claudeSpec = await createStandaloneCliLaunchResolver(baseDeps, "claude")(theater, {
        commodoreId: "comm-1",
        sessionId: "standalone-cli:claude",
        objectiveRecordType: "standalone-cli:claude",
      });
      expect(claudeSpec.args).toContain("--dangerously-skip-permissions");
      const mcpIdx = claudeSpec.args.indexOf("--mcp-config");
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      const claudeConfigPath = claudeSpec.args[mcpIdx + 1]!;
      expect(claudeSpec.args.join(" ")).not.toContain("tok-claude-secret");
      const claudeMcp = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8")) as { mcpServers: Record<string, { type: string; url: string; headers: { Authorization: string } }> };
      expect(claudeMcp.mcpServers["fleet-browser"]).toEqual({
        type: "http",
        url: "http://127.0.0.1:4199/mcp/fleet-browser",
        headers: { Authorization: "Bearer tok-claude-secret" },
      });
      await claudeSpec.cleanup?.();
      expect(fs.existsSync(claudeConfigPath)).toBe(false);

      const agySpec = await createStandaloneCliLaunchResolver(baseDeps, "antigravity")(theater, {
        commodoreId: "comm-1",
        sessionId: "standalone-cli:antigravity",
        objectiveRecordType: "standalone-cli:antigravity",
      });
      expect(agySpec.bin).toBe(agyBin);
      expect(agySpec.args).toContain("--dangerously-skip-permissions");
      expect(agySpec.args).not.toContain("--mode");
      expect(agySpec.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(agySpec.env.FLEET_CONSOLE_SESSION_ID).toBeUndefined();
      const addDirIdx = agySpec.args.indexOf("--add-dir");
      expect(addDirIdx).toBeGreaterThanOrEqual(0);
      const addDir = agySpec.args[addDirIdx + 1]!;
      expect(agySpec.args.join(" ")).not.toContain("tok-antigravity-secret");
      const agyPlugin = JSON.parse(fs.readFileSync(path.join(addDir, ".agents/plugins/fleet-browser/plugin.json"), "utf8")) as { name: string };
      const agyMcp = JSON.parse(fs.readFileSync(path.join(addDir, ".agents/plugins/fleet-browser/mcp_config.json"), "utf8")) as { mcpServers: Record<string, { serverUrl: string; headers: { Authorization: string } }> };
      expect(agyPlugin.name).toBe("fleet-browser");
      expect(agyMcp.mcpServers["fleet-browser"]).toEqual({
        serverUrl: "http://127.0.0.1:4199/mcp/fleet-browser",
        headers: { Authorization: "Bearer tok-antigravity-secret" },
      });
      await agySpec.cleanup?.();
      expect(fs.existsSync(addDir)).toBe(false);

      expect(preparedCalls).toEqual([
        { cli: "claude", cwd: theater, commodoreId: "comm-1" },
        { cli: "antigravity", cwd: theater, commodoreId: "comm-1" },
      ]);
      expect(releases).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

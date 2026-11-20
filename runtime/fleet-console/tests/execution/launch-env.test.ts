import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { StandaloneCliPlugin } from "../../features/execution/host/standalone-cli/global-plugins.js";
import { createStandaloneCliLaunchResolver } from "../../features/execution/host/standalone-cli/launch.js";
import { registerStandaloneCliRoutes } from "../../features/execution/host/standalone-cli/routes.js";
import type { ConsoleRuntimeContext } from "../../features/execution/host/context.js";
import type { TerminalRuntime, TerminalTicketContext } from "../../features/execution/host/terminal/index.js";
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

  it("injects fleet-browser MCP and global plugins into Claude Code without putting secrets in argv, and cleans up on exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-standalone-cli-mcp-"));
    try {
      const claudeBin = path.join(root, "claude");
      fs.writeFileSync(claudeBin, "#!/bin/sh\n", { mode: 0o755 });
      const home = path.join(root, "home");
      const theater = path.join(root, "theater");
      const preparedCalls: Array<{ cli: string; cwd: string; commodoreId: string | null }> = [];
      let releases = 0;
      const browserMcp = {
        prepare: async (options: { readonly cli: "claude"; readonly cwd: string; readonly commodoreId: string | null }) => {
          preparedCalls.push({ cli: options.cli, cwd: options.cwd, commodoreId: options.commodoreId });
          return {
            endpointUrl: "http://127.0.0.1:4199/mcp/fleet-browser",
            bearerToken: `tok-${options.cli}-secret`,
            release: async () => { releases += 1; },
          };
        },
      };
      const alphaDir = path.join(root, "plugins", "alpha");
      const betaDir = path.join(root, "plugins", "beta");
      fs.mkdirSync(path.join(alphaDir, ".claude-plugin"), { recursive: true });
      fs.mkdirSync(betaDir, { recursive: true });
      fs.writeFileSync(path.join(alphaDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "alpha" }));
      const globalPlugins = (): StandaloneCliPlugin[] => [
        {
          id: "alpha@market",
          name: "alpha",
          path: alphaDir,
          mcpServers: {
            "plugin:alpha:remote": { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${ALPHA_KEY}" } },
            "plugin:alpha:docs": { type: "http", url: "https://mcp.example/docs" },
          },
          env: { ALPHA_KEY: "alpha-secret" },
        },
        { id: "beta@market", name: "beta", path: betaDir, mcpServers: {}, env: {} },
      ];
      const baseDeps = {
        env: { PATH: "/usr/bin:/bin", HOME: home, CLAUDE_BIN: claudeBin, FLEET_CONSOLE_SESSION_ID: "parent" },
        aiGateway: { routePath: "/api/v1/ai-gateway", origin: () => "http://127.0.0.1:4100" },
        browserMcp,
        globalPlugins,
        homeDir: home,
      };

      const extraTheaterA = path.join(root, "theater-a");
      const extraTheaterB = path.join(root, "theater-b");
      fs.mkdirSync(theater, { recursive: true });
      fs.mkdirSync(extraTheaterA, { recursive: true });
      fs.mkdirSync(extraTheaterB, { recursive: true });
      const readAddDirs = (args: readonly string[]): string[] =>
        args.flatMap((arg, index) => (arg === "--add-dir" && args[index + 1] ? [args[index + 1]!] : []));
      const additionalDirectories = [theater, extraTheaterA, extraTheaterB, extraTheaterA];

      const claudeSpec = await createStandaloneCliLaunchResolver(baseDeps, "claude")(theater, {
        commodoreId: "comm-1",
        additionalDirectories,
        sessionId: "standalone-cli:claude",
        objectiveRecordType: "standalone-cli:claude",
      });
      expect(claudeSpec.args).toContain("--dangerously-skip-permissions");
      expect(readAddDirs(claudeSpec.args)).toEqual([extraTheaterA, extraTheaterB]);
      expect(claudeSpec.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe("1");
      // 전역 플러그인은 설치본 그대로 `--plugin-dir`로, MCP 키는 자식 환경으로만 간다.
      expect(claudeSpec.args.flatMap((arg, index) => (arg === "--plugin-dir" ? [claudeSpec.args[index + 1]] : []))).toEqual([alphaDir, betaDir]);
      expect(claudeSpec.env.ALPHA_KEY).toBe("alpha-secret");
      expect(claudeSpec.args.join(" ")).not.toContain("alpha-secret");
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
      expect(fs.existsSync(extraTheaterA)).toBe(true);
      expect(fs.existsSync(extraTheaterB)).toBe(true);

      expect(preparedCalls).toEqual([
        { cli: "claude", cwd: theater, commodoreId: "comm-1" },
      ]);
      expect(releases).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("issues standalone CLI tickets with the commodore's other available theaters as additionalDirectories", async () => {
    const issued: TerminalTicketContext[] = [];
    let routeHandler: ((input: { req: { method: string }; res: unknown; pathname: string }) => Promise<boolean>) | null = null;
    const responses: Array<{ status: number; body: unknown }> = [];
    const theaters: Record<string, string | null> = {
      "t-main": "/work/main",
      "t-extra": "/work/extra",
      "t-missing": null,
      "t-dup": "/work/extra",
    };
    const ctx = {
      basePath: "/api/v1",
      host: {
        lifecycle: { registerCleanup: () => {} },
        security: {
          isTerminalAuthorized: () => true,
          resolveTerminalSocketRole: () => "control",
        },
        http: {
          readJsonBody: async () => ({ cli: "claude", commodoreId: "comm-1", theaterId: "t-main" }),
          writeJson: (_res: unknown, status: number, body: unknown) => { responses.push({ status, body }); },
        },
        paths: {
          listCommodoreTheaters: (commodoreId: string) => (commodoreId === "comm-1"
            ? Object.keys(theaters).map((id) => ({ id, label: id }))
            : []),
          resolveCommodoreTheaterPath: (_commodoreId: string, theaterId: string) => theaters[theaterId] ?? null,
        },
      },
      registerRouter: (_path: string, handler: typeof routeHandler) => { routeHandler = handler; },
    } as unknown as ConsoleRuntimeContext;
    const terminalRuntime = {
      registerLaunchResolver: () => () => {},
      onExit: () => () => {},
      isLive: () => false,
      issueTicket: (context: TerminalTicketContext) => {
        issued.push(context);
        return { ticket: "tok-1", ttlMs: 10_000, role: "control" as const };
      },
      invalidateTicketsForSession: () => {},
      terminate: () => {},
    } as unknown as TerminalRuntime;

    registerStandaloneCliRoutes(ctx, terminalRuntime, {
      aiGateway: { routePath: "/api/v1/ai-gateway", origin: () => "http://127.0.0.1:4100" },
    });

    const handled = await routeHandler!({ req: { method: "POST" }, res: {}, pathname: "/api/v1/standalone-cli/ticket" });
    expect(handled).toBe(true);
    expect(responses[0]?.status).toBe(200);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.cwd).toBe("/work/main");
    expect(issued[0]?.additionalDirectories).toEqual(["/work/extra"]);
  });
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import * as Admiral from "../src/index.js";
import { buildHostShellCommand, buildPowerShellCommand, escapeTomlBasicString } from "../src/agent-cli/builders/toml.js";
import { injectAgentCliProfile } from "../src/agent-cli/injection.js";
import { createAgentCliPlugin } from "../src/agent-cli/plugin/index.js";
import type { AgentCliProfile, FleetHookExec } from "../src/agent-cli/types.js";

interface TestDedicatedMcpSession {
  readonly issuedRequests: Array<{ readonly label: string; readonly cwd: string }>;
  readonly releasedLabels: string[];
  getEndpoint(): Promise<{ readonly servers: readonly { readonly name: string; readonly url: string }[] }>;
  issueSessionToken(request: { readonly label: string; readonly cwd: string }): readonly { readonly name: string; readonly token: string }[];
  releaseSessionToken(label: string): void;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI session resume and capture hooks", () => {
  it("places Claude --resume before Fleet injection flags", async () => {
    const root = createTempRoot("fleet-admiral-claude-resume-");
    const profile = baseProfile("claude", {
      args: ["--model", "claude-opus"],
      cwd: root,
      env: { HOME: root },
    });
    const resumeSessionId = randomUUID();
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      origin: { kind: "resume", sessionId: resumeSessionId },
    }));

    expect(injected.args.slice(0, 4)).toEqual(["--model", "claude-opus", "--resume", resumeSessionId]);
    expect(indexOfSequence(injected.args, ["--resume", resumeSessionId])).toBeLessThan(indexOfSequence(injected.args, ["--plugin-dir"]));
    expect(indexOfSequence(injected.args, ["--resume", resumeSessionId])).toBeLessThan(indexOfSequence(injected.args, ["--mcp-config"]));
    // 주입 인자의 마지막 가족을 기준으로 잰다 — 바이패스 플래그는 옵트인일 때만 실리므로
    // 순서 계약의 기준점이 될 수 없다.
    expect(indexOfSequence(injected.args, ["--resume", resumeSessionId])).toBeLessThan(indexOfSequence(injected.args, ["--allowedTools"]));
    // 이어 붙이는 세션은 id를 고를 수 없다 — 자식이 `--session-id`를 함께 받으면 거부한다.
    expect(injected.args).not.toContain("--session-id");
    expect(injected.session.sessionId).toBe(resumeSessionId);
  });

  // 회귀: 호스트가 이미 좌표를 들고 오는 argv(`fleet --resume <id>`·`fleet -c`)에 `--session-id`를
  // 얹으면 자식이 곧바로 거부한다. 좌표를 싣는 쪽이 그 규칙을 알아야 한다.
  it("adds no session flag when the profile's own args already carry a coordinate", async () => {
    const root = createTempRoot("fleet-admiral-claude-passthrough-");
    for (const passthrough of [["--resume", "sid-from-user"], ["-c"], ["--continue"], ["--resume=sid-inline"]]) {
      const profile = baseProfile("claude", { args: passthrough, cwd: root, env: { HOME: root } });
      const injected = await injectAgentCliProfile(profile, baseInjectOptions(root));

      expect(injected.args).not.toContain("--session-id");
      expect(injected.args).not.toContain("--fork-session");
      // 사용자의 좌표는 그대로 남고, 우리는 플러그인만 싣는다.
      expect(injected.args.slice(0, passthrough.length)).toEqual(passthrough);
      expect(injected.args).toContain("--plugin-dir");
      injected.cleanup?.();
    }
  });

  it("pins a Fleet-issued session id for a new session, and forks with a fresh one", async () => {
    const root = createTempRoot("fleet-admiral-claude-pin-");
    const profile = baseProfile("claude", { args: [], cwd: root, env: { HOME: root } });

    const fresh = await injectAgentCliProfile(profile, baseInjectOptions(root));
    expect(indexOfSequence(fresh.args, ["--session-id", fresh.session.sessionId])).toBeGreaterThanOrEqual(0);
    expect(fresh.args).not.toContain("--resume");
    // 세션 좌표와 무관하게 모든 런치는 Fleet 데이터 디렉터리의 공유 트리를 읽는다.
    expect(fresh.session.pluginRoot.endsWith(path.join("harness", "claude"))).toBe(true);

    const from = randomUUID();
    const forked = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      origin: { kind: "fork", from },
    }));
    expect(indexOfSequence(forked.args, ["--resume", from, "--fork-session", "--session-id", forked.session.sessionId])).toBe(0);
    expect(forked.session.sessionId).not.toBe(from);
  });



  it("exports createSessionCaptureHookExec from the root only", () => {
    const exec = Admiral.createSessionCaptureHookExec({
      entryPath: "/tmp/fleet-console/src/cli.ts",
      provider: "claude",
      tsxLoader: "/tmp/fleet-console/node_modules/tsx/dist/loader.mjs",
    });
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      readonly exports?: Record<string, unknown>;
    };

    expect(exec).toEqual({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL("/tmp/fleet-console/node_modules/tsx/dist/loader.mjs").href,
        "/tmp/fleet-console/src/cli.ts",
        "hook",
        "capture-session",
        "claude",
      ],
    });
    expect(packageJson.exports && Object.keys(packageJson.exports)).toEqual(["."]);
    expect(packageJson.exports).not.toHaveProperty("./agent-cli/session-capture-hook");
  });

  it("creates capture hook exec without a tsx loader for JavaScript entries", () => {
    const exec = Admiral.createSessionCaptureHookExec({
      entryPath: "/tmp/fleet-console/dist/cli.mjs",
      execPath: "/usr/local/bin/node",
      provider: "claude",
    });

    expect(exec).toEqual({
      command: "/usr/local/bin/node",
      args: ["/tmp/fleet-console/dist/cli.mjs", "hook", "capture-session", "claude"],
    });
  });

  it("renders the background report alongside turn end without a second hook on Stop", async () => {
    const root = createTempRoot("fleet-admiral-background-hooks-");
    const profile = baseProfile("claude", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root, {
      turnEndHookExec: hookExec("node", ["console.js", "hook", "turn-end"]),
      backgroundReportHookExec: hookExec("node", ["console.js", "hook", "background-report"]),
    }));
    const pluginRootIndex = injected.args.indexOf("--plugin-dir") + 1;
    const pluginRoot = injected.args[pluginRootIndex];
    expect(pluginRootIndex).toBeGreaterThan(0);
    expect(typeof pluginRoot).toBe("string");
    const hooksJson = JSON.parse(readFileSync(path.join(pluginRoot as string, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, unknown>;
    };

    // 같은 이벤트에 두 hook을 걸면 병렬로 떠서 턴 종료가 홀로 먼저 도착하는 프레임이 생긴다.
    // Stop의 백그라운드 보고는 턴 종료 hook이 함께 실어 나르므로 Stop에는 hook이 하나뿐이다.
    expect(hooksJson.hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["console.js", "hook", "turn-end"] }] },
    ]);
    expect(hooksJson.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["console.js", "hook", "background-report"] }] },
    ]);
    // 위임 디스패치 게이트는 퇴역했다 — input-waiting 훅이 없으면 PreToolUse 자체가 렌더되지 않는다.
    expect(hooksJson.hooks.PreToolUse).toBeUndefined();
    // Workflow 뒤에는 접수증 계약을 붙인다. delegation 스킬 전후에는 훅을 걸지 않는다 —
    // Claude Code의 `if`는 퍼미션 룰로 평가되고 Skill 도구에는 룰 콘텐츠 매처가 없어
    // `Skill(<name>)` 조건이 항상 거짓이 된다.
    expect(hooksJson.hooks.PostToolUse).toEqual([
      { matcher: "Workflow", hooks: [{ type: "command", command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "workflow-receipt"] }] },
    ]);
    expect(hooksJson.hooks.PostToolUseFailure).toBeUndefined();
    expect(hooksJson.hooks.SessionEnd).toBeUndefined();
    injected.cleanup?.();
  });

  it("renders Claude capture on UserPromptSubmit", async () => {
    const root = createTempRoot("fleet-admiral-claude-hooks-");
    const dataDir = path.join(root, "data");
    const plugin = await createAgentCliPlugin({
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "claude"]),
      cliId: "claude",
      cwd: root,
      dataDir,
    });
    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: {
        readonly SessionStart?: readonly { readonly hooks: readonly unknown[] }[];
        readonly UserPromptSubmit: readonly { readonly hooks: readonly unknown[] }[];
      };
    };

    expect(hooksJson.hooks.SessionStart).toEqual([{
      hooks: [{
        args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "plugin-version", expect.any(String)],
        command: process.execPath,
        type: "command",
      }],
    }]);
    expect(hooksJson.hooks.UserPromptSubmit).toHaveLength(1);
    // 위임 라우팅은 delegation 스킬 description이 소유한다 — UserPromptSubmit에는 호스트 훅만 남는다.
    expect(hooksJson.hooks.UserPromptSubmit[0]?.hooks).toEqual([
      { args: ["console.js", "hook", "capture-session", "claude"], command: "node", type: "command" },
    ]);
    expect(existsSync(path.join(plugin.pluginRoot, ".codex-plugin", "plugin.json"))).toBe(false);
  });








});

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function baseProfile(
  id: AgentCliProfile["id"],
  options: {
    readonly args: readonly string[];
    readonly binPrefixArgs?: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
): AgentCliProfile {
  return {
    args: options.args,
    bin: id,
    ...(options.binPrefixArgs ? { binPrefixArgs: options.binPrefixArgs } : {}),
    cwd: options.cwd,
    env: options.env,
    id,
    label: id,
    terminalName: "xterm-256color",
  };
}

function baseInjectOptions(
  root: string,
  overrides: {
    readonly autoNameHookExec?: FleetHookExec;
    readonly backgroundReportHookExec?: FleetHookExec;
    readonly captureSessionHookExec?: FleetHookExec;
    readonly dedicatedMcpSession?: TestDedicatedMcpSession;
    readonly gatewayDelegationModels?: Parameters<typeof injectAgentCliProfile>[1]["gatewayDelegationModels"];
    readonly inputWaitingHookExec?: FleetHookExec;
    readonly origin?: Parameters<typeof injectAgentCliProfile>[1]["origin"];
    readonly turnEndHookExec?: FleetHookExec;
    readonly turnStartHookExec?: FleetHookExec;
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    dataDir: path.join(root, "data"),
    dedicatedMcpSession: overrides.dedicatedMcpSession ?? createDedicatedMcpSession(),
    ...(overrides.autoNameHookExec ? { autoNameHookExec: overrides.autoNameHookExec } : {}),
    ...(overrides.backgroundReportHookExec ? { backgroundReportHookExec: overrides.backgroundReportHookExec } : {}),
    ...(overrides.captureSessionHookExec ? { captureSessionHookExec: overrides.captureSessionHookExec } : {}),
    ...(overrides.gatewayDelegationModels ? { gatewayDelegationModels: overrides.gatewayDelegationModels } : {}),
    ...(overrides.inputWaitingHookExec ? { inputWaitingHookExec: overrides.inputWaitingHookExec } : {}),
    ...(overrides.origin ? { origin: overrides.origin } : {}),
    ...(overrides.turnEndHookExec ? { turnEndHookExec: overrides.turnEndHookExec } : {}),
    ...(overrides.turnStartHookExec ? { turnStartHookExec: overrides.turnStartHookExec } : {}),
  };
}

function createDedicatedMcpSession(
  options: {
    readonly servers?: readonly { readonly name: string; readonly url: string }[];
    readonly tokens?: readonly { readonly name: string; readonly token: string }[];
  } = {},
): TestDedicatedMcpSession {
  const issuedRequests: Array<{ readonly label: string; readonly cwd: string }> = [];
  const releasedLabels: string[] = [];
  const servers = options.servers ?? [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }];
  const tokens = options.tokens ?? [{ name: "fleet", token: "token-123" }];
  return {
    issuedRequests,
    releasedLabels,
    async getEndpoint() {
      return { servers };
    },
    issueSessionToken(request) {
      issuedRequests.push(request);
      return tokens;
    },
    releaseSessionToken(label: string) {
      releasedLabels.push(label);
    },
  };
}

function readTextFilesRecursively(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? readTextFilesRecursively(entryPath) : [readFileSync(entryPath, "utf8")];
  });
}

function hookExec(command: string, args: readonly string[]): FleetHookExec {
  return { args, command };
}

function indexOfSequence(values: readonly string[], sequence: readonly string[]): number {
  const index = values.findIndex((_, candidateIndex) =>
    sequence.every((expected, sequenceIndex) => values[candidateIndex + sequenceIndex] === expected));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

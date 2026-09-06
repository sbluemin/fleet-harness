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

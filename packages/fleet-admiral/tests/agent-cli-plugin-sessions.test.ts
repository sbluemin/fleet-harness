import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliPlugin, pluginSessionsRoot, removePluginSession } from "../src/agent-cli/plugin/index.js";
import type { CreateAgentCliPluginOptions } from "../src/agent-cli/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI plugin session store", () => {
  it("publishes the tree under the workspace's sessions/<sessionId>", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-root-");
    const sessionId = randomUUID();

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    const sessionsRoot = pluginSessionsRoot(dataDir, cwd);
    expect(path.dirname(plugin.pluginRoot)).toBe(sessionsRoot);
    expect(path.basename(plugin.pluginRoot)).toBe(sessionId);
    expect(plugin.sessionId).toBe(sessionId);
    expect(plugin.pluginRoots).toEqual([plugin.pluginRoot]);
    // 저장 위치의 정의는 admiral 한 곳에만 있다: workspaces/<name>/sessions/<sessionId>.
    expect(sessionsRoot.startsWith(path.join(dataDir, "workspaces") + path.sep)).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "agents"))).toBe(true);
    // sessions/ 아래에는 세션 트리 말고 아무것도 살지 않는다.
    expect(readdirSync(sessionsRoot)).toEqual([sessionId]);
  });

  it("rejects a session id that cannot name a directory", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-badid-");

    await expect(
      createAgentCliPlugin(options({ cwd, dataDir, sessionId: "../escape" })),
    ).rejects.toThrow(/cannot name a directory/);
  });

  // 이 저장소의 핵심 성질이다: 세션마다 트리가 다르므로 다른 런치가 실행 중인 세션의 훅·스킬·
  // 정체성을 바꿔칠 방법 자체가 없다. 로스터가 갈려도 남의 트리는 바이트 하나 바뀌지 않는다.
  it("leaves a running session's tree untouched when another session renders a different roster", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-isolation-");

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: randomUUID() }));
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const hooksPath = path.join(first.pluginRoot, "hooks", "hooks.json");
    const guardBefore = readFileSync(guardPath, "utf8");
    const hooksBefore = readFileSync(hooksPath, "utf8");

    const second = await createAgentCliPlugin({
      ...options({ cwd, dataDir, sessionId: randomUUID() }),
      gatewayDelegationModels: [requireGatewayModel("cursor--grok-4.5")],
    });

    expect(second.pluginRoot).not.toBe(first.pluginRoot);
    expect(existsSync(first.pluginRoot)).toBe(true);
    expect(readFileSync(guardPath, "utf8")).toBe(guardBefore);
    expect(readFileSync(hooksPath, "utf8")).toBe(hooksBefore);
    expect(readdirSync(path.join(second.pluginRoot, "agents")).length).toBeGreaterThan(0);
    expect(readdirSync(path.join(first.pluginRoot, "agents"))).toEqual([]);
  });

  // 한 세션의 트리는 런치 하나가 독점한다 — 같은 Claude 세션을 두 표면이 함께 여는 상태를
  // Console이 상위에서 거부하므로, 여기서 만나는 기존 트리는 반드시 끝난 런치의 잔해다.
  // 살리거나 검증할 이유가 없으므로 무조건 걷고 다시 쓴다.
  it("replaces whatever the previous launch left behind", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-replace-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const original = readFileSync(guardPath, "utf8");
    // 잔해의 모든 모습: 변조된 파일, 사라진 필수 디렉터리, 발행 중 끊긴 흔적, 낯선 여분 파일.
    writeFileSync(guardPath, "// tampered\n");
    rmSync(path.join(first.pluginRoot, "agents"), { recursive: true, force: true });
    rmSync(path.join(first.pluginRoot, ".fleet-session.json"), { force: true });
    writeFileSync(path.join(first.pluginRoot, "stray.txt"), "left over\n");

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(readFileSync(guardPath, "utf8")).toBe(original);
    expect(existsSync(path.join(second.pluginRoot, "agents"))).toBe(true);
    expect(existsSync(path.join(second.pluginRoot, ".fleet-session.json"))).toBe(true);
    // 이전 런치의 여분 파일까지 남지 않는다 — 트리는 통째로 새것이다.
    expect(existsSync(path.join(second.pluginRoot, "stray.txt"))).toBe(false);
  });

  // 심링크로 바꿔치기된 agents/도 잔해의 한 형태다. no-follow 규약대로 실디렉터리로 되돌아온다.
  it("replaces a tree whose agents directory was swapped for a symlink", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-agents-link-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    const agentsPath = path.join(first.pluginRoot, "agents");
    const outside = path.join(dataDir, "outside-agents");
    mkdirSync(outside, { recursive: true });
    rmSync(agentsPath, { recursive: true, force: true });
    // Windows에서는 junction이 권한 없이 생성 가능하다. POSIX에서는 type 인자가 무시된다.
    symlinkSync(outside, agentsPath, "junction");

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    const restored = readdirSync(second.pluginRoot, { withFileTypes: true }).find((entry) => entry.name === "agents");
    expect(restored?.isDirectory()).toBe(true);
    expect(restored?.isSymbolicLink()).toBe(false);
  });

  // 트리는 세션의 것이지 런치의 것이 아니다. 런치가 끝났다고 걷으면, 살아 있는 세션의
  // 플러그인이 CLI↔Chat 전환마다 사라졌다 다시 생긴다.
  it("keeps the tree in place for the session's whole life", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-persist-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    expect(existsSync(guardPath)).toBe(true);

    // 한 런치가 끝나고 다음 런치가 서기 전에도 트리는 그 자리에 있다.
    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(existsSync(guardPath)).toBe(true);
    expect(readdirSync(pluginSessionsRoot(dataDir, cwd))).toEqual([sessionId]);
  });

  // 트리는 런치가 끝나도 남지만 세션 자체가 사라지면 읽을 주체도 없다 — 그때 호스트가 걷는다.
  it("removes only the named session's tree when the host reclaims it", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-reclaim-");
    const goneId = randomUUID();
    const keptId = randomUUID();

    const gone = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: goneId }));
    const kept = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: keptId }));

    removePluginSession({ cwd, dataDir, sessionId: goneId });

    expect(existsSync(gone.pluginRoot)).toBe(false);
    expect(existsSync(kept.pluginRoot)).toBe(true);
    expect(readdirSync(pluginSessionsRoot(dataDir, cwd))).toEqual([keptId]);
  });

  it("survives a reclaim for a session, workspace, or data dir that is not there", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-reclaim-absent-");

    // 어느 쪽도 던지지 않고, 없는 워크스페이스를 만들지도 않는다 — 회수는 자리를 세우지 않는다.
    expect(() => removePluginSession({ cwd, dataDir, sessionId: randomUUID() })).not.toThrow();
    expect(() => removePluginSession({ cwd, dataDir, sessionId: "../escape" })).not.toThrow();
    expect(() => removePluginSession({ cwd: path.join(cwd, "absent"), dataDir, sessionId: randomUUID() })).not.toThrow();
    expect(existsSync(path.join(dataDir, "workspaces"))).toBe(false);
  });

  describe("legacy marketplace tree", () => {
    it("never writes into it, and leaves a recently rendered one alone", async () => {
      const { dataDir, cwd } = createRoots("fleet-admiral-session-legacy-recent-");
      const legacyRoot = seedLegacyMarketplace(dataDir);

      const plugin = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: randomUUID() }));

      expect(plugin.pluginRoot.startsWith(path.join(dataDir, "workspaces") + path.sep)).toBe(true);
      // 방금 렌더된 흔적이 있으면 구버전 런치가 살아 있을 수 있다 — 손대지 않는다.
      expect(readFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "utf8")).toBe("{\"hooks\":{}}\n");
    });

    it("reclaims only what Fleet rendered once the tree has gone stale", async () => {
      const { dataDir, cwd } = createRoots("fleet-admiral-session-legacy-stale-");
      const legacyRoot = seedLegacyMarketplace(dataDir);
      const marketplaceRoot = path.join(dataDir, "marketplace");

      await createAgentCliPlugin({
        ...options({ cwd, dataDir, sessionId: randomUUID() }),
        legacyReclaimDeps: { staleAfterMs: 0 },
      });

      expect(existsSync(legacyRoot)).toBe(false);
      expect(existsSync(path.join(marketplaceRoot, ".claude-plugin"))).toBe(false);
      // 사용자가 직접 둔 파일은 Fleet이 쓴 것이 아니므로 남는다.
      expect(readFileSync(path.join(marketplaceRoot, "user-note.txt"), "utf8")).toBe("legacy user file\n");
    });
  });

  it("wires AskUserQuestion PreToolUse and input-waiting Notification hooks for a gateway session", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-hooks-");

    const plugin = await createAgentCliPlugin({
      ...options({ cwd, dataDir, sessionId: randomUUID() }),
      inputWaitingHookExec: { command: "node", args: ["cli.mjs", "hook", "attention"] },
      backgroundReportHookExec: { command: "node", args: ["cli.mjs", "hook", "background-report"] },
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, unknown>;
    };
    // AskUserQuestion은 Notification 훅을 발화하지 않으므로 PreToolUse(정확 매처)로 잡는다.
    // Agent|Workflow에는 위임 게이트가 상주한다. spawn 카운팅 신호가 아니라 핀되지 않은 위임을
    // 실행 전에 차단할 뿐이라 #554가 우려한 카운팅 불일치와 무관하다.
    expect(hooksJson.hooks.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
      { matcher: "Agent|Workflow", hooks: [{ type: "command", command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "gate-delegation"] }] },
    ]);
    expect(hooksJson.hooks.PostToolUse).toEqual([
      {
        matcher: "Workflow",
        hooks: [{
          type: "command",
          command: process.execPath,
          args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "workflow-receipt"],
        }],
      },
    ]);
    // delegation 스킬 전후에는 훅을 걸지 않는다. Claude Code의 `if`는 퍼미션 룰로 평가되고
    // Skill 도구에는 룰 콘텐츠 매처가 없어 `Skill(<name>)` 조건이 항상 거짓이 되기 때문이다.
    expect(hooksJson.hooks.PostToolUseFailure).toBeUndefined();
    expect(hooksJson.hooks.SessionEnd).toBeUndefined();
    expect(JSON.stringify(hooksJson)).not.toContain("Skill(fleet:delegation)");
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
    expect(hooksJson.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "background-report"] }] },
    ]);
    // 그 외 입력 대기는 입력 대기 Notification 타입만 |-구분 정확 매처로 거른다.
    expect(hooksJson.hooks.Notification).toEqual([
      { matcher: "permission_prompt|elicitation_dialog", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
  });

  it("wires capture, turn-start, and auto-name onto Claude UserPromptSubmit in order", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-uphooks-");

    const plugin = await createAgentCliPlugin({
      ...options({ cwd, dataDir, sessionId: randomUUID() }),
      captureSessionHookExec: { command: "node", args: ["cli.mjs", "hook", "capture-session", "claude"] },
      turnStartHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-start"] },
      turnEndHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-end"] },
      autoNameHookExec: { command: "node", args: ["cli.mjs", "hook", "auto-name"] },
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, ReadonlyArray<{ readonly hooks: ReadonlyArray<{ readonly args: readonly string[] }> }>>;
    };
    const userPromptSubmit = hooksJson.hooks.UserPromptSubmit?.[0]?.hooks ?? [];
    expect(userPromptSubmit.slice(0, 3).map((hook) => hook.args[2])).toEqual(["capture-session", "turn-start", "auto-name"]);
    // delegation 스킬 라우팅 트립와이어는 host 훅 뒤에 선다. 로스터와 핀 문법은
    // 스킬 완료 뒤 PostToolUse가 공급하고, 여기서는 필요한 요청에서 스킬을 먼저 열게 한다.
    expect(userPromptSubmit[3]?.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs",
      "remind",
    ]);
    expect(userPromptSubmit).toHaveLength(4);
    expect(hooksJson.hooks.Stop?.[0]?.hooks.map((hook) => hook.args[2])).toEqual(["turn-end"]);
  });

  it("renders exactly the selected on-demand skill assets", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-skills-");

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: randomUUID() }));

    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(readdirSync(skillsRoot).sort()).toEqual([
      "delegation",
      "professional-pushback",
    ]);
    for (const skillName of readdirSync(skillsRoot)) {
      expect(existsSync(path.join(skillsRoot, skillName, "SKILL.md"))).toBe(true);
    }
    // 실시간 로스터·핀 규율은 스킬 본문이 아니라 훅과 모델 가드가 소유한다.
    expect(existsSync(path.join(plugin.pluginRoot, "agents"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
  });
});

function options(input: {
  readonly cwd: string;
  readonly dataDir: string;
  readonly sessionId: string;
}): CreateAgentCliPluginOptions {
  return { cliId: "claude", cwd: input.cwd, dataDir: input.dataDir, sessionId: input.sessionId };
}

function createRoots(prefix: string): { readonly dataDir: string; readonly cwd: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const cwd = path.join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return { dataDir: path.join(root, "data"), cwd };
}

function requireGatewayModel(modelId: string): GatewayModel {
  const model = findGatewayModel(modelId);
  if (!model) throw new Error(`Catalog model missing for test: ${modelId}`);
  return model;
}

function readSessionManifest(pluginRoot: string): { readonly contentHash: string; readonly renderedAt: number } {
  return JSON.parse(readFileSync(path.join(pluginRoot, ".fleet-session.json"), "utf8")) as {
    readonly contentHash: string;
    readonly renderedAt: number;
  };
}

function seedLegacyMarketplace(dataDir: string): string {
  const legacyRoot = path.join(dataDir, "marketplace", "plugins", "fleet-gateway");
  mkdirSync(path.join(legacyRoot, "hooks"), { recursive: true });
  mkdirSync(path.join(dataDir, "marketplace", ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "{\"hooks\":{}}\n");
  writeFileSync(path.join(dataDir, "marketplace", "user-note.txt"), "legacy user file\n");
  return legacyRoot;
}


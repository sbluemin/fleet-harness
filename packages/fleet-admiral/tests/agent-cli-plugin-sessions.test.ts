import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliPlugin, pluginSessionsRoot } from "../src/agent-cli/plugin/index.js";
import { reclaimPluginSessions } from "../src/agent-cli/plugin/session-store.js";
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
    // sessions/ 아래에는 세션 트리와 홀더 말고는 아무것도 살지 않는다 — 발행은 제자리에 쓴다.
    expect(readdirSync(sessionsRoot).sort()).toEqual([".holders", sessionId]);
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

  it("reuses the same tree when the same session relaunches with identical content", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-reuse-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    const manifestBefore = readSessionManifest(first.pluginRoot);
    first.cleanup();
    // 정상 종료한 세션은 자기 트리를 걷고 간다 — 재개가 그때 다시 렌더한다.
    expect(existsSync(first.pluginRoot)).toBe(false);

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(readSessionManifest(second.pluginRoot).contentHash).toBe(manifestBefore.contentHash);
  });

  // 제자리에 쓰므로 발행 중 죽으면 반쯤 쓰인 트리가 남는다. 매니페스트를 맨 마지막에 쓰는
  // 순서가 그것을 다음 런치에서 손상으로 드러나게 하는 유일한 장치다.
  it("repairs a tree whose publish was interrupted before the manifest landed", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-partial-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    dropHolders(dataDir, cwd, sessionId);
    // 중단된 발행의 흔적: 파일은 일부 있고 매니페스트가 없다.
    rmSync(path.join(first.pluginRoot, ".fleet-session.json"), { force: true });
    rmSync(path.join(first.pluginRoot, "hooks"), { recursive: true, force: true });

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(existsSync(path.join(second.pluginRoot, ".fleet-session.json"))).toBe(true);
    expect(existsSync(path.join(second.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
  });

  it("repairs a corrupt tree when no launch holds it", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-repair-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const original = readFileSync(guardPath, "utf8");
    // 홀더만 지우고 트리는 남긴다 — 홀더를 반납하지 못하고 죽은 런치의 잔해다.
    dropHolders(dataDir, cwd, sessionId);
    writeFileSync(guardPath, "// tampered\n");

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(readFileSync(guardPath, "utf8")).toBe(original);
  });

  // 빈 로스터 트리의 agents/는 파일이 없는 필수 디렉터리다 — 파일 바이트 검증만으로는 그
  // 부재를 못 잡으므로, 디렉터리 소실도 손상으로 판정되어 복구 경로가 발동해야 한다.
  it("repairs a tree whose required empty agents directory was lost", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-agents-dir-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    dropHolders(dataDir, cwd, sessionId);
    rmSync(path.join(first.pluginRoot, "agents"), { recursive: true, force: true });

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(existsSync(path.join(second.pluginRoot, "agents"))).toBe(true);
  });

  // 심링크로 바꿔치기된 agents/는 실디렉터리가 아니다 — no-follow 판정으로 손상 처리되어
  // 복구 경로가 실디렉터리를 되살린다.
  it("treats a symlinked agents directory as corruption and repairs it", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-agents-link-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    dropHolders(dataDir, cwd, sessionId);
    const agentsPath = path.join(first.pluginRoot, "agents");
    const outside = path.join(dataDir, "outside-agents");
    mkdirSync(outside, { recursive: true });
    rmSync(agentsPath, { recursive: true, force: true });
    // Windows에서는 junction이 권한 없이 생성 가능하다. POSIX에서는 type 인자가 무시된다.
    symlinkSync(outside, agentsPath, "junction");

    const second = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));

    expect(second.pluginRoot).toBe(first.pluginRoot);
    const restored = readdirSync(second.pluginRoot, { withFileTypes: true }).find((entry) => entry.name === "agents");
    expect(restored?.isDirectory()).toBe(true);
    expect(restored?.isSymbolicLink()).toBe(false);
  });

  it("refuses to relaunch onto a differing tree that a live launch still holds", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-held-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    writeFileSync(path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"), "// tampered\n");

    // 홀더는 아직 살아 있다(이 테스트 프로세스의 pid). 실행 중 런치가 읽는 트리는 고쳐 쓰지
    // 않고 새 런치를 시끄럽게 실패시킨다.
    await expect(
      createAgentCliPlugin(options({ cwd, dataDir, sessionId })),
    ).rejects.toThrow(/in use by another launch/);
  });

  // 트리를 발행하고 자식 pid를 붙이기 전에 런처가 죽으면, 홀더 pid는 죽어 보이지만 자식은
  // 살아날 수 있다. 그 창 안의 흔적은 살아 있는 것으로 취급한다.
  it("refuses to repair a differing tree that carries a recent dead-pid holder trace", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-orphan-");
    const sessionId = randomUUID();

    const first = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    dropHolders(dataDir, cwd, sessionId);
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    writeFileSync(guardPath, "// tampered\n");
    writeDeadHolder(dataDir, cwd, sessionId);

    await expect(
      createAgentCliPlugin(options({ cwd, dataDir, sessionId })),
    ).rejects.toThrow(/in use by another launch/);
    expect(readFileSync(guardPath, "utf8")).toBe("// tampered\n");
  });

  it("moves the holder onto the child pid that actually reads the tree", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-attach-");
    const sessionId = randomUUID();

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    expect(readHolders(dataDir, cwd, sessionId).map((holder) => holder.pid)).toEqual([process.pid]);

    plugin.attach(424242);

    const [holder] = readHolders(dataDir, cwd, sessionId);
    expect(holder?.pid).toBe(424242);
    expect(holder?.launcherPid).toBe(process.pid);
  });

  it("removes the tree and its holders on cleanup, and cleanup is idempotent", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-cleanup-");
    const sessionId = randomUUID();

    const plugin = await createAgentCliPlugin(options({ cwd, dataDir, sessionId }));
    expect(readHolders(dataDir, cwd, sessionId)).toHaveLength(1);

    plugin.cleanup();
    plugin.cleanup();

    expect(existsSync(plugin.pluginRoot)).toBe(false);
    expect(readHolders(dataDir, cwd, sessionId)).toEqual([]);
  });

  it("reclaims a crashed launch's tree past the grace window and keeps a held one", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-reclaim-");
    const heldId = randomUUID();
    const orphanId = randomUUID();

    const held = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: heldId }));
    const orphan = await createAgentCliPlugin(options({ cwd, dataDir, sessionId: orphanId }));
    dropHolders(dataDir, cwd, orphanId);
    writeDeadHolder(dataDir, cwd, orphanId);
    const sessionsRoot = pluginSessionsRoot(dataDir, cwd);

    // 유예 안에서는 죽은 pid 흔적도 살아 있는 것으로 취급한다.
    reclaimPluginSessions(sessionsRoot, heldId);
    expect(existsSync(orphan.pluginRoot)).toBe(true);

    // 유예 밖으로 나가면 회수한다. 홀더가 살아 있는 트리는 그대로 둔다.
    reclaimPluginSessions(sessionsRoot, heldId, { now: () => Date.now() + 11 * 60 * 1000 });

    expect(existsSync(orphan.pluginRoot)).toBe(false);
    expect(existsSync(held.pluginRoot)).toBe(true);
  });

  it("serializes concurrent renders of the same session and leaves no staging behind", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-session-race-");
    const sessionId = randomUUID();

    const [first, second] = await Promise.all([
      createAgentCliPlugin(options({ cwd, dataDir, sessionId })),
      createAgentCliPlugin(options({ cwd, dataDir, sessionId })),
    ]);

    expect(first.pluginRoot).toBe(second.pluginRoot);
    expect(readHolders(dataDir, cwd, sessionId)).toHaveLength(2);
    expect(readdirSync(pluginSessionsRoot(dataDir, cwd)).sort()).toEqual([".holders", sessionId]);
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
    // orchestration 스킬 전후에는 훅을 걸지 않는다. Claude Code의 `if`는 퍼미션 룰로 평가되고
    // Skill 도구에는 룰 콘텐츠 매처가 없어 `Skill(<name>)` 조건이 항상 거짓이 되기 때문이다.
    expect(hooksJson.hooks.PostToolUseFailure).toBeUndefined();
    expect(hooksJson.hooks.SessionEnd).toBeUndefined();
    expect(JSON.stringify(hooksJson)).not.toContain("Skill(fleet:orchestration)");
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
    // orchestration 스킬 라우팅 트립와이어는 host 훅 뒤에 선다. 로스터와 핀 문법은
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
      "orchestration",
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
  return { cliId: "claude-gateway", cwd: input.cwd, dataDir: input.dataDir, sessionId: input.sessionId };
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

function holdersDir(dataDir: string, cwd: string, sessionId: string): string {
  return path.join(pluginSessionsRoot(dataDir, cwd), ".holders", sessionId);
}

function readHolders(
  dataDir: string,
  cwd: string,
  sessionId: string,
): Array<{ readonly pid?: number; readonly launcherPid?: number }> {
  const dir = holdersDir(dataDir, cwd, sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((entry) => JSON.parse(readFileSync(path.join(dir, entry), "utf8")) as { pid?: number });
}

/** 홀더만 지운다 — 트리는 남기고 "반납하지 못하고 죽은 런치"의 잔해를 만든다. */
function dropHolders(dataDir: string, cwd: string, sessionId: string): void {
  rmSync(holdersDir(dataDir, cwd, sessionId), { recursive: true, force: true });
}

/** 방금 종료된 프로세스의 pid로 죽은 홀더 흔적을 남긴다 — 런처만 죽은 상태의 재현. */
function writeDeadHolder(dataDir: string, cwd: string, sessionId: string): void {
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
  const dir = holdersDir(dataDir, cwd, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${deadPid}-orphan.json`), `${JSON.stringify({ pid: deadPid, startedAt: Date.now() })}\n`);
}

function seedLegacyMarketplace(dataDir: string): string {
  const legacyRoot = path.join(dataDir, "marketplace", "plugins", "fleet-gateway");
  mkdirSync(path.join(legacyRoot, "hooks"), { recursive: true });
  mkdirSync(path.join(dataDir, "marketplace", ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "{\"hooks\":{}}\n");
  writeFileSync(path.join(dataDir, "marketplace", "user-note.txt"), "legacy user file\n");
  return legacyRoot;
}


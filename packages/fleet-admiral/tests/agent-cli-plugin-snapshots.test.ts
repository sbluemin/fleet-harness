import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel, type GatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliPlugin } from "../src/agent-cli/plugin/index.js";
import { gcPluginSnapshots } from "../src/agent-cli/plugin/snapshot.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const SNAPSHOT_DIR_PATTERN = /^fleet-gateway-[0-9a-f]{16}$/;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI plugin snapshot store", () => {
  it("publishes an immutable content-addressed snapshot under plugin-snapshots/", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-root-");

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withPluginStoreLock: async (_target, fn) => fn(),
    });

    const snapshotsRoot = path.join(dataDir, "plugin-snapshots");
    expect(path.dirname(plugin.pluginRoot)).toBe(snapshotsRoot);
    expect(path.basename(plugin.pluginRoot)).toMatch(SNAPSHOT_DIR_PATTERN);
    expect(plugin.pluginRoots).toEqual([plugin.pluginRoot]);
    expect(existsSync(path.join(plugin.pluginRoot, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "agents"))).toBe(true);
    const manifest = readSnapshotManifest(plugin.pluginRoot);
    expect(path.basename(plugin.pluginRoot)).toBe(`fleet-gateway-${manifest.contentHash.slice(0, 16)}`);
    expect(findStagingEntries(snapshotsRoot)).toEqual([]);
  });

  it("reuses the published snapshot for identical content instead of re-rendering", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-reuse-");
    const options = () => ({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withPluginStoreLock: async <T>(_target: string, fn: () => T | Promise<T>) => fn(),
    });

    const first = await createAgentCliPlugin(options());
    const firstManifest = readSnapshotManifest(first.pluginRoot);
    const second = await createAgentCliPlugin(options());

    expect(second.pluginRoot).toBe(first.pluginRoot);
    // renderedAt이 그대로면 두 번째 확보는 발행을 건너뛰고 검증-재사용만 했다는 뜻이다.
    expect(readSnapshotManifest(second.pluginRoot).renderedAt).toBe(firstManifest.renderedAt);
  });

  // 회귀 고정: 다른 로스터의 런치가 앞선 세션의 스냅숏을 어떤 바이트도 바꾸지 못한다.
  // 고정 디렉터리 시절에는 나중 런치가 실행 중 세션의 훅·정체성 파일을 통째로 갈아치웠다.
  it("leaves an in-flight session's snapshot untouched when a different roster renders", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-mixed-");
    const lock = async <T>(_target: string, fn: () => T | Promise<T>) => fn();

    const first = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withPluginStoreLock: lock,
    });
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const hooksPath = path.join(first.pluginRoot, "hooks", "hooks.json");
    const guardBefore = readFileSync(guardPath, "utf8");
    const hooksBefore = readFileSync(hooksPath, "utf8");

    const second = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      gatewayDelegationModels: [requireGatewayModel("cursor--grok-4.5")],
      withPluginStoreLock: lock,
    });

    expect(second.pluginRoot).not.toBe(first.pluginRoot);
    expect(existsSync(first.pluginRoot)).toBe(true);
    expect(readFileSync(guardPath, "utf8")).toBe(guardBefore);
    expect(readFileSync(hooksPath, "utf8")).toBe(hooksBefore);
    // 새 스냅숏은 자기 로스터의 정체성 파일을 실었고, 앞선 스냅숏의 agents/는 빈 그대로다.
    expect(readdirSync(path.join(second.pluginRoot, "agents")).length).toBeGreaterThan(0);
    expect(readdirSync(path.join(first.pluginRoot, "agents"))).toEqual([]);
  });

  it("never writes into the legacy marketplace tree", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-legacy-");
    const legacyRoot = path.join(dataDir, "marketplace", "plugins", "fleet-gateway");
    mkdirSync(path.join(legacyRoot, "hooks"), { recursive: true });
    writeFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "{\"hooks\":{}}\n", { flag: "wx" });
    writeFileSync(path.join(dataDir, "marketplace", "user-note.txt"), "legacy user file\n", { flag: "wx" });

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withPluginStoreLock: async (_target, fn) => fn(),
    });

    // 구버전 CLI가 계속 쓰는 레거시 레인은 읽지도 쓰지도 않는다 — 스냅숏은 형제 네임스페이스다.
    expect(plugin.pluginRoot.startsWith(path.join(dataDir, "plugin-snapshots") + path.sep)).toBe(true);
    expect(readFileSync(path.join(legacyRoot, "hooks", "hooks.json"), "utf8")).toBe("{\"hooks\":{}}\n");
    expect(readFileSync(path.join(dataDir, "marketplace", "user-note.txt"), "utf8")).toBe("legacy user file\n");
    expect(existsSync(path.join(dataDir, "marketplace", ".claude-plugin"))).toBe(false);
  });

  it("repairs a corrupt snapshot when no session leases it", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-repair-");
    const lock = async <T>(_target: string, fn: () => T | Promise<T>) => fn();

    const first = await createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock });
    first.cleanup();
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    const original = readFileSync(guardPath, "utf8");
    writeFileSync(guardPath, "// tampered\n");

    const second = await createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock });

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(readFileSync(guardPath, "utf8")).toBe(original);
  });

  // 빈 로스터 스냅숏의 agents/는 파일이 없는 필수 디렉터리다 — 파일 바이트 검증만으로는
  // 그 부재를 못 잡으므로, 디렉터리 소실도 손상으로 판정되어 복구 경로가 발동해야 한다.
  it("repairs a snapshot whose required empty agents directory was lost", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-agents-dir-");
    const lock = async <T>(_target: string, fn: () => T | Promise<T>) => fn();

    const first = await createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock });
    first.cleanup();
    rmSync(path.join(first.pluginRoot, "agents"), { recursive: true, force: true });

    const second = await createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock });

    expect(second.pluginRoot).toBe(first.pluginRoot);
    expect(existsSync(path.join(second.pluginRoot, "agents"))).toBe(true);
  });

  it("refuses the launch when a corrupt snapshot is still leased by a live session", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-corrupt-leased-");
    const lock = async <T>(_target: string, fn: () => T | Promise<T>) => fn();

    const first = await createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock });
    const guardPath = path.join(first.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs");
    writeFileSync(guardPath, "// tampered\n");

    // 리스는 아직 살아 있다(이 테스트 프로세스의 pid). 실행 중 세션이 쥔 트리는 고쳐 쓰지 않고
    // 새 런치를 시끄럽게 실패시킨다.
    await expect(
      createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock }),
    ).rejects.toThrow(/corrupt while sessions still lease it/);
  });

  it("releases its lease on cleanup, and cleanup is idempotent", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-lease-");

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withPluginStoreLock: async (_target, fn) => fn(),
    });

    const leaseDir = path.join(dataDir, "plugin-snapshots", "leases", path.basename(plugin.pluginRoot));
    expect(readdirSync(leaseDir)).toHaveLength(1);
    plugin.cleanup();
    plugin.cleanup();
    expect(readdirSync(leaseDir)).toHaveLength(0);
  });

  it("collects an unleased snapshot past the grace window and keeps a leased one", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-gc-");
    const lock = async <T>(_target: string, fn: () => T | Promise<T>) => fn();

    const released = await createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock: lock });
    released.cleanup();
    const leased = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      gatewayDelegationModels: [requireGatewayModel("cursor--grok-4.5")],
      withPluginStoreLock: lock,
    });
    backdateSnapshot(released.pluginRoot);
    backdateSnapshot(leased.pluginRoot);

    // 세 번째 내용의 확보가 GC를 돌린다: 유예를 넘긴 무리스 스냅숏만 걷힌다.
    await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      gatewayDelegationModels: [requireGatewayModel("cursor--grok-4.5"), requireGatewayModel("codex--gpt-5.6-sol")],
      withPluginStoreLock: lock,
    });

    expect(existsSync(released.pluginRoot)).toBe(false);
    // 리스 pid가 살아 있는 스냅숏은 유예를 넘겨도 걷지 않는다.
    expect(existsSync(leased.pluginRoot)).toBe(true);
  });

  it("caps unleased snapshots even inside the grace window", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-snapshot-cap-"));
    tempDirs.push(root);
    const dirNames: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const dirName = `fleet-gateway-${index.toString(16).padStart(16, "0")}`;
      dirNames.push(dirName);
      mkdirSync(path.join(root, dirName), { recursive: true });
      writeFileSync(
        path.join(root, dirName, ".fleet-snapshot.json"),
        `${JSON.stringify({ version: 1, contentHash: dirName.slice("fleet-gateway-".length), renderedAt: 1_000 + index }, null, 2)}\n`,
      );
    }

    gcPluginSnapshots(root, "fleet-gateway", "fleet-gateway-current0000000", {
      now: () => 2_000,
      isPidAlive: () => false,
    });

    const survivors = readdirSync(root).filter((entry) => SNAPSHOT_DIR_PATTERN.test(entry)).sort();
    // 유예 안이라도 리스 흔적 없는 스냅숏은 상한(8)까지만 남는다 — 가장 오래된 것부터 걷힌다.
    expect(survivors).toEqual(dirNames.slice(2).sort());
  });

  // 데몬이 재시작하면 리스 pid는 죽어 보여도 그 데몬이 띄운 자식이 스냅숏을 읽고 있을 수 있다.
  // 죽은 pid라도 리스 흔적이 남아 있으면 유예 안에서는 상한으로도 걷지 않는다.
  it("keeps a dead-pid-leased snapshot inside the grace window even beyond the cap", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-snapshot-orphan-"));
    tempDirs.push(root);
    const dirNames: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const dirName = `fleet-gateway-${index.toString(16).padStart(16, "0")}`;
      dirNames.push(dirName);
      mkdirSync(path.join(root, dirName), { recursive: true });
      writeFileSync(
        path.join(root, dirName, ".fleet-snapshot.json"),
        `${JSON.stringify({ version: 1, contentHash: dirName.slice("fleet-gateway-".length), renderedAt: 1_000 + index }, null, 2)}\n`,
      );
    }
    // 가장 오래된 스냅숏에 죽은 pid의 리스 흔적을 남긴다 — 고아 자식이 있을 수 있는 상태.
    const orphanLeaseDir = path.join(root, "leases", dirNames[0]!);
    mkdirSync(orphanLeaseDir, { recursive: true });
    writeFileSync(path.join(orphanLeaseDir, "12345-orphan.json"), `${JSON.stringify({ pid: 12345, startedAt: 1_000 })}\n`);

    gcPluginSnapshots(root, "fleet-gateway", "fleet-gateway-current0000000", {
      now: () => 2_000,
      isPidAlive: () => false,
    });

    const survivors = readdirSync(root).filter((entry) => SNAPSHOT_DIR_PATTERN.test(entry)).sort();
    // 흔적 있는 0번은 상한을 이겨 살아남고, 흔적 없는 1번만 상한으로 걷힌다.
    expect(survivors).toContain(dirNames[0]!);
    expect(survivors).not.toContain(dirNames[1]!);

    // 유예를 넘기면 죽은 pid 리스 흔적도 더는 보호가 아니다 — 잔존 리스크는 24h로 수용한다.
    // lastUsedAt은 리스 파일의 실제 mtime도 반영하므로 실제 시계 기준으로 유예를 넘긴다.
    gcPluginSnapshots(root, "fleet-gateway", "fleet-gateway-current0000000", {
      now: () => Date.now() + 25 * 60 * 60 * 1000,
      isPidAlive: () => false,
    });
    expect(readdirSync(root).filter((entry) => SNAPSHOT_DIR_PATTERN.test(entry))).toEqual([]);
    expect(existsSync(orphanLeaseDir)).toBe(false);
  });

  it("serializes concurrent acquisitions through the store lock and converges on one snapshot", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-race-");
    const snapshotsRoot = path.join(dataDir, "plugin-snapshots");
    let firstLockHeld = false;
    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const secondWaited = createDeferred<void>();
    const lockLog: string[] = [];
    const lockTailByTarget = new Map<string, Promise<void>>();
    const withPluginStoreLock = async <T>(target: string, fn: () => T | Promise<T>): Promise<T> => {
      expect(target).toBe(snapshotsRoot);
      const previous = lockTailByTarget.get(target);
      const releaseCurrent = createDeferred<void>();
      lockTailByTarget.set(target, releaseCurrent.promise);
      if (previous) {
        secondWaited.resolve(undefined);
        await previous;
      }
      lockLog.push("enter");
      try {
        if (!firstLockHeld) {
          firstLockHeld = true;
          firstEntered.resolve(undefined);
          await releaseFirst.promise;
        }
        return await fn();
      } finally {
        releaseCurrent.resolve(undefined);
        if (lockTailByTarget.get(target) === releaseCurrent.promise) lockTailByTarget.delete(target);
        lockLog.push("exit");
      }
    };

    const firstRender = createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock });
    await firstEntered.promise;
    const secondRender = createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withPluginStoreLock });
    await secondWaited.promise;
    releaseFirst.resolve(undefined);
    const [first, second] = await Promise.all([firstRender, secondRender]);

    expect(first.pluginRoots).toEqual(second.pluginRoots);
    expect(lockLog).toEqual(["enter", "exit", "enter", "exit"]);
    expect(findStagingEntries(snapshotsRoot)).toEqual([]);
  });

  it("wires AskUserQuestion PreToolUse and input-waiting Notification hooks for a gateway session", async () => {
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-hooks-");
    const inputWaitingHookExec = { command: "node", args: ["cli.mjs", "hook", "attention"] };

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      inputWaitingHookExec,
      backgroundReportHookExec: { command: "node", args: ["cli.mjs", "hook", "background-report"] },
      withPluginStoreLock: async (_target, fn) => fn(),
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
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-uphooks-");

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      captureSessionHookExec: { command: "node", args: ["cli.mjs", "hook", "capture-session", "claude"] },
      turnStartHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-start"] },
      turnEndHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-end"] },
      autoNameHookExec: { command: "node", args: ["cli.mjs", "hook", "auto-name"] },
      withPluginStoreLock: async (_target, fn) => fn(),
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
    const { dataDir, cwd } = createRoots("fleet-admiral-snapshot-skills-");

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withPluginStoreLock: async (_target, fn) => fn(),
    });

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

function readSnapshotManifest(snapshotRoot: string): { readonly contentHash: string; readonly renderedAt: number } {
  return JSON.parse(readFileSync(path.join(snapshotRoot, ".fleet-snapshot.json"), "utf8")) as {
    readonly contentHash: string;
    readonly renderedAt: number;
  };
}

/** 스냅숏의 renderedAt과 리스 흔적을 GC 유예(24h) 밖으로 밀어낸다. */
function backdateSnapshot(snapshotRoot: string): void {
  const manifestPath = path.join(snapshotRoot, ".fleet-snapshot.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.renderedAt = Date.now() - 25 * 60 * 60 * 1000;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function findStagingEntries(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((entry) => entry.startsWith(".fleet-stage-")).sort();
}

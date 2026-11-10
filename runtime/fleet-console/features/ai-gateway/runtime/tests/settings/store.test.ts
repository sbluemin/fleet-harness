import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeAiGatewaySettings, parseAiGatewayUpdate, resolveAiGatewaySelection } from "../../src/settings/index.js";
import { buildGatewayCandidates } from "../../src/fleet/model-loadout.js";
import { decideGatewayRoutingAssignment } from "../../src/fleet/routing-decision.js";
import { createAiGatewaySettingsStore } from "../../src/settings/store.js";
import { applyClaudeNativeModels } from "../../src/models.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  applyClaudeNativeModels([]);
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

/** 격리된 Fleet 데이터 루트. 실 사용자 홈(`~/.fleet`)을 절대 건드리지 않게 항상 주입한다. */
function createDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fleet-ai-gateway-"));
  temporaryDirectories.push(dir);
  return dir;
}

/** 이 설정이 예전에 살던 호스트 디렉터리를 흉내낸다. 그 시절 파일은 compact JSON이었다. */
function seedLegacySettings(root: string, value: unknown): string {
  const legacyDir = path.join(root, "previous-fleet");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(path.join(legacyDir, "ai-gateway.json"), JSON.stringify(value), "utf-8");
  return legacyDir;
}

describe("ai-gateway settings store", () => {
  it("persists as a single file in the Fleet data root", () => {
    const dataDir = createDataDir();
    const store = createAiGatewaySettingsStore({ dataDir });

    expect(store.path).toBe(path.join(dataDir, "ai-gateway.json"));
    expect(store.read()).toEqual({ version: 1 });
    // 읽기만으로는 파일이 생기지 않는다 — 미구성과 "빈 설정을 저장함"은 다른 상태다.
    expect(existsSync(store.path)).toBe(false);

    store.write({ models: [{ id: "xai--grok-4.7" }] });
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({
      version: 1,
      models: [{ id: "xai--grok-4.7" }],
    });
  });

  it("persists, carries over, and explicitly clears providerPriority", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });

    store.write({ providerPriority: ["codex"] });
    expect(store.read()).toEqual({ version: 1, models: [], providerPriority: ["codex"] });

    store.write({ models: [{ id: "codex--gpt-6-luna" }] });
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-luna" }],
      providerPriority: ["codex"],
    });

    store.write({ providerPriority: [] });
    expect(store.read()).toEqual({ version: 1, models: [] });
  });

  it("persists compactCeiling independently of models", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    store.write({ models: [{ id: "codex--gpt-6-luna" }] });
    store.writeCompactCeiling("early");
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-luna" }],
      compactCeiling: "early",
    });
    store.write({ models: [{ id: "codex--gpt-6.1-sol" }] });
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6.1-sol" }],
      compactCeiling: "early",
    });
    store.writeCompactCeiling(94);
    expect(store.read()?.compactCeiling).toBe(94);
    store.writeCompactCeiling(undefined);
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6.1-sol" }],
    });
  });

  it("persists xaiEndpoint independently of models", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    store.write({ models: [{ id: "codex--gpt-6-luna" }] });
    store.writeXaiEndpoint("cli-proxy");
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-luna" }],
      xaiEndpoint: "cli-proxy",
    });
    // A models-only save must not silently move the endpoint back to the default.
    store.write({ models: [{ id: "codex--gpt-6.1-sol" }] });
    expect(store.read()?.xaiEndpoint).toBe("cli-proxy");
    store.writeXaiEndpoint(undefined);
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6.1-sol" }],
    });
  });

  it("keeps the wire-log choice independent of model selection", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    store.write({ models: [{ id: "codex--gpt-6-luna" }] });
    store.writeWireLogEnabled(false);
    expect(store.read()).toEqual({ version: 1, models: [{ id: "codex--gpt-6-luna" }], wireLogEnabled: false });
    store.write(undefined);
    expect(store.read()).toEqual({ version: 1, models: [], wireLogEnabled: false });
    store.writeWireLogEnabled(undefined);
    expect(store.read()).toEqual({ version: 1, models: [] });
  });

  it("adopts the settings from the host directory it is given, without announcing it", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, {
      version: 1,
      models: [{ id: "muse-code--muse-spark-1.3-contributor", efforts: ["high"] }, { id: "codex--gpt-6.1-sol" }],
      defaultModel: "codex--gpt-6.1-sol",
      wireLogEnabled: false,
    });
    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });

    // 레거시 defaultModel은 승계 시 조용히 버린다.
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "muse-code--muse-spark-1.3-contributor", efforts: ["high"] }, { id: "codex--gpt-6.1-sol" }],
      wireLogEnabled: false,
    });
    // 승계는 새 축에 실제로 안착해야 한다 — 매 부팅 과거 파일을 다시 읽는 상태로 남으면 안 된다.
    expect(existsSync(store.path)).toBe(true);
    // 값을 옮긴 뒤 과거 파일은 걷는다. 남겨 두면 아무도 읽지 않는 파일이 사용자의 데이터
    // 루트에 영구히 남고, 어느 쪽이 사실인지 눈으로 구분할 수 없다.
    expect(existsSync(path.join(legacyDir, "ai-gateway.json"))).toBe(false);
  });

  it("never consumes its own file when the slot and the previous root are the same directory", () => {
    // 호스트 설정에 따라 둘이 같은 디렉터리로 풀린다(`FLEET_CONSOLE_DATA_DIR`만 지정한 실행).
    // 자기 자신을 승계했다고 판정하면 옛 파일을 걷는 동작이 살아 있는 선별을 지운다.
    const dataDir = createDataDir();
    writeFileSync(
      path.join(dataDir, "ai-gateway.json"),
      JSON.stringify({ version: 1, models: [{ id: "codex--gpt-6.1-sol" }] }),
      "utf-8",
    );

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [dataDir] });
    store.writeWireLogEnabled(true);

    expect(existsSync(store.path)).toBe(true);
    expect(store.read().models).toEqual([{ id: "codex--gpt-6.1-sol" }]);
  });

  it("performs no adoption when no host directory is given", () => {
    const dataDir = createDataDir();
    seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6.1-sol" }] });
    const store = createAiGatewaySettingsStore({ dataDir });

    expect(store.read()).toEqual({ version: 1 });
    expect(existsSync(store.path)).toBe(false);
  });

  it("never overwrites settings that already exist on the new axis", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6.1-sol" }] });
    createAiGatewaySettingsStore({ dataDir }).write({ models: [{ id: "codex--gpt-6-luna" }] });

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    expect(store.read()).toEqual({ version: 1, models: [{ id: "codex--gpt-6-luna" }] });
  });

  it("treats an emptied selection as a real state rather than something to re-adopt or re-seed", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6.1-sol" }] });
    // 사용자가 전부 지운 상태. 빈 배열로 남아 승계도, 기본 로스터 이행도 되살리지 않는다.
    createAiGatewaySettingsStore({ dataDir }).write(undefined);

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    expect(store.read()).toEqual({ version: 1, models: [] });
    expect(store.seedModels(["claude--sonnet"])).toBe(false);
    expect(store.read()).toEqual({ version: 1, models: [], rosterSeedVersion: 5 });
  });

  it("migrates the roster once: seeds an unchosen roster, adds Claude to a Claude-less list, and never re-adds what the user turned off", () => {
    const seed = ["claude--fable-1m", "claude--opus-1m", "claude--sonnet-1m"];
    const claude = seed.map((id) => ({ id, efforts: ["low", "medium", "high"] }));

    // 한 번도 고르지 않은 설치(키 부재) — 기본 로스터를 써 넣고 표식을 남긴다.
    const fresh = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    fresh.writeWireLogEnabled(false);
    expect(fresh.seedModels(seed)).toBe(true);
    const seeded = { version: 1, wireLogEnabled: false, models: claude, rosterSeedVersion: 5 };
    expect(fresh.read()).toEqual(seeded);
    // 멱등 — 두 번째 기동은 아무것도 바꾸지 않고, 사용자가 그 뒤 고친 로스터(Claude를 끈 것 포함)도 되살리지 않는다.
    expect(fresh.seedModels(seed)).toBe(false);
    expect(fresh.read()).toEqual(seeded);
    fresh.write({ models: [{ id: "codex--gpt-6.1-sol" }] });
    expect(fresh.seedModels(seed)).toBe(false);
    expect(fresh.read()).toEqual({ version: 1, wireLogEnabled: false, models: [{ id: "codex--gpt-6.1-sol" }], rosterSeedVersion: 5 });

    // 업그레이드 — Claude 없이 비어 있지 않은 목록에는 Claude를 뒤에 더한다(예전에는 Claude가 늘 깔려 있었다).
    const upgraded = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    writeFileSync(upgraded.path, JSON.stringify({ version: 1, models: [{ id: "codex--gpt-6.1-sol", efforts: ["high"] }] }));
    expect(upgraded.seedModels(seed)).toBe(true);
    expect(upgraded.read()?.models).toEqual([{ id: "codex--gpt-6.1-sol", efforts: ["low", "medium", "high"] }, ...claude]);
    // 이행 뒤 사용자가 Claude를 끄면 다음 기동이 다시 넣지 않는다.
    upgraded.write({ models: [{ id: "codex--gpt-6.1-sol", efforts: ["high"] }] });
    expect(upgraded.seedModels(seed)).toBe(false);
    expect(upgraded.read()?.models).toEqual([{ id: "codex--gpt-6.1-sol", efforts: ["low", "medium", "high"] }]);

    // Claude 항목이 이미 있는 목록은 사용자가 Claude를 고른 것이다 — 목록은 그대로, 표식만 남긴다.
    const chosen = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    writeFileSync(chosen.path, JSON.stringify({ version: 1, models: [{ id: "claude--opus-1m" }, { id: "codex--gpt-6.1-sol" }] }));
    expect(chosen.seedModels(seed)).toBe(false);
    expect(chosen.read()).toEqual({ version: 1, models: [{ id: "claude--opus-1m" }, { id: "codex--gpt-6.1-sol" }], rosterSeedVersion: 5 });

    // 승계가 먼저다 — 옛 자리의 선별을 받은 뒤 같은 규칙으로 이행한다.
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6.1-sol" }] });
    const adopted = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    expect(adopted.seedModels(seed)).toBe(true);
    expect(adopted.read()?.models).toEqual([{ id: "codex--gpt-6.1-sol" }, ...claude]);
  });

  it("releases a Claude host-only flag left from the ignored era once, then honours one the user sets again", () => {
    const seed = ["claude--fable-1m", "claude--opus-1m", "claude--sonnet-1m"];
    const delegable = (store: ReturnType<typeof createAiGatewaySettingsStore>) => resolveAiGatewaySelection(store.read()).delegationModels.map((model) => model.id);
    const onDisk = (value: unknown) => {
      const dataDir = createDataDir();
      writeFileSync(path.join(dataDir, "ai-gateway.json"), JSON.stringify(value), "utf-8");
      const store = createAiGatewaySettingsStore({ dataDir });
      // CLI처럼 호스트 시드 없이 저장해도 아직 수행하지 않은 이행 표식은 건너뛰지 않는다.
      const before = store.read();
      store.write({ models: before.models });
      expect(store.read().rosterSeedVersion).toBe(before.rosterSeedVersion);
      return store;
    };

    // 1판까지 끝난 설치 — Claude hostOnly는 그 시기 화면에서 꺼진 것으로 보였다. 한 번 지우고, 다른 공급자 표식·강도는 둔다.
    const seeded = onDisk({ version: 1, models: [{ id: "claude--opus-1m", efforts: ["high"], hostOnly: true }, { id: "codex--gpt-6.1-sol", hostOnly: true }], rosterSeedVersion: 1 });
    expect(seeded.seedModels(seed)).toBe(true);
    expect(seeded.read()).toEqual({ version: 1, models: [{ id: "claude--opus-1m", efforts: ["low", "medium", "high"] }], rosterSeedVersion: 5 });
    expect(delegable(seeded)).toEqual(["claude--opus-1m"]);
    // 4판 이후의 hostOnly 키는 버린다. 항목은 켠 채로 남고, 빠진 low는 다시 합쳐진다.
    seeded.write({ models: [{ id: "claude--opus-1m", efforts: ["high"], hostOnly: true }, { id: "codex--gpt-6.1-sol", hostOnly: true }] } as never);
    expect(seeded.seedModels(seed)).toBe(false);
    expect(seeded.read()?.models).toEqual([
      { id: "claude--opus-1m", efforts: ["low", "medium", "high"] },
      { id: "codex--gpt-6.1-sol" },
    ]);
    expect(delegable(seeded)).toEqual(["codex--gpt-6.1-sol", "claude--opus-1m"]);

    // 표식 없는 옛 설치 — 1판(Claude가 이미 있으니 목록은 그대로)과 2판(해제)이 한 번에 돈다. 구 200k 좌표는 1M id로 접힌다.
    const legacy = onDisk({ version: 1, models: [{ id: "claude--sonnet", hostOnly: true }] });
    expect(legacy.seedModels(seed)).toBe(true);
    expect(legacy.read()).toEqual({ version: 1, models: [{ id: "claude--sonnet-1m" }], rosterSeedVersion: 5 });
    // Claude 없는 목록 — 1판이 Claude를 더하고, 다른 공급자의 호스트 전용은 그대로다.
    const claudeless = onDisk({ version: 1, models: [{ id: "codex--gpt-6.1-sol", hostOnly: true }] });
    expect(claudeless.seedModels(seed)).toBe(true);
    expect(claudeless.read()?.models).toEqual(seed.map((id) => ({ id, efforts: ["low", "medium", "high"] })));
    // 해제할 것이 없는 1판 설치는 표식만 올린다.
    const clean = onDisk({ version: 1, models: [{ id: "claude--sonnet" }], rosterSeedVersion: 1 });
    expect(clean.seedModels(seed)).toBe(false);
    expect(clean.read()).toEqual({ version: 1, models: [{ id: "claude--sonnet-1m" }], rosterSeedVersion: 5 });

    // 2판 설치의 3판(1M 단일화) — 같은 가족의 200k·1M 두 좌표는 먼저 나온 자리 한 행으로 합친다. 노출 강도는 합집합,
    // 사용자가 다시 둔 호스트 전용은 어느 한쪽만 켰어도 남는다. 2판의 해제는 다시 돌지 않는다.
    const doubled = onDisk({ version: 1, models: [
      { id: "claude--sonnet", efforts: ["high"], hostOnly: true },
      { id: "codex--gpt-6.1-sol" },
      { id: "claude--sonnet-1m", efforts: ["low"] },
      { id: "claude--opus" },
      { id: "claude--opus-1m", efforts: ["max"] },
    ], rosterSeedVersion: 2 });
    expect(doubled.seedModels(seed)).toBe(true);
    const merged = [
      { id: "codex--gpt-6.1-sol" },
      // 한쪽이 사다리 전체였으면 전체다. hostOnly로 합쳐진 Sonnet은 켠 목록에서 빠진다.
      { id: "claude--opus-1m" },
    ];
    expect(doubled.read()).toEqual({ version: 1, models: merged, rosterSeedVersion: 5 });
    expect(JSON.parse(readFileSync(doubled.path, "utf-8")).models).toEqual(merged);
    expect(delegable(doubled)).toEqual(["codex--gpt-6.1-sol", "claude--opus-1m"]);
    // 2판에서 Claude를 끈 목록은 3판이 되살리지 않는다.
    const claudeOff = onDisk({ version: 1, models: [{ id: "codex--gpt-6.1-sol" }], rosterSeedVersion: 2 });
    expect(claudeOff.seedModels(seed)).toBe(false);
    expect(claudeOff.read()).toEqual({ version: 1, models: [{ id: "codex--gpt-6.1-sol" }], rosterSeedVersion: 5 });

    // 4판: hostOnly는 켜 둔 변형을 남긴 채 빠지고, 남은 계열은 가장 큰 창 하나, 강도는 low–high에 켠 xhigh·max만 더한다.
    const migrated = onDisk({
      version: 1,
      rosterSeedVersion: 3,
      models: [
        { id: "codex--gpt-6.1-sol", efforts: ["medium"] },
        { id: "codex--gpt-6.1-sol-1m-fast", hostOnly: true, efforts: ["max"] },
        { id: "xai--grok-4.7", hostOnly: true },
        { id: "claude--opus-1m", efforts: ["xhigh", "max"] },
        { id: "antigravity--gemini-3.8-flash", efforts: ["high"] },
      ],
    });
    expect(migrated.seedModels(seed)).toBe(true);
    expect(migrated.read()?.models).toEqual([
      { id: "codex--gpt-6.1-sol", efforts: ["low", "medium", "high"] },
      { id: "claude--opus-1m" },
      { id: "antigravity--gemini-3.8-flash" },
    ]);
    expect(migrated.seedModels(seed)).toBe(false);
  });

  it("migrates high once and keeps a later opt-out through writes, restart, and delegation", () => {
    const dataDir = createDataDir();
    const store = createAiGatewaySettingsStore({ dataDir });
    const id = "codex--gpt-6.1-sol";
    writeFileSync(store.path, JSON.stringify({ version: 1, rosterSeedVersion: 4, models: [
      { id, fast: true, efforts: ["low", "medium", "xhigh"] },
    ] }));
    // 표식을 쓰기 전 읽기에서도 high를 잃지 않고, 나머지 선택은 그대로 남는다.
    const migrated = [{ id, fast: true, efforts: ["low", "medium", "high", "xhigh"] }];
    expect(store.read().models).toEqual(migrated);
    store.seedModels([]);
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual({ version: 1, rosterSeedVersion: 5, models: migrated });

    const off = parseAiGatewayUpdate({ models: [{ id, fast: true, efforts: ["low", "medium"] }] });
    if (!off.ok) throw new Error("valid effort choice rejected");
    // 4판 표식에서도 시드보다 먼저 온 저장은 high 끔을 보존하며 5판으로 넘어간다.
    writeFileSync(store.path, JSON.stringify({ ...store.read(), rosterSeedVersion: 4 }));
    store.write(off.value);
    expect(store.read().rosterSeedVersion).toBe(5);
    store.writeWireLogEnabled(false);
    const restarted = createAiGatewaySettingsStore({ dataDir });
    expect(restarted.seedModels([])).toBe(false);
    const settings = restarted.read();
    expect(normalizeAiGatewaySettings(settings)).toEqual(settings);
    expect(settings.models).toEqual([{ id, fast: true, efforts: ["low", "medium"] }]);
    const exposure = resolveAiGatewaySelection(settings);
    expect(buildGatewayCandidates(exposure).candidates[0]?.efforts).toEqual(["low", "medium"]);
    // deep의 목표 high도 노출 사다리 안의 medium으로 내려간다. 명시 stage 요청도 같은 규칙이다.
    expect(decideGatewayRoutingAssignment({ surface: "agent", requestedModel: "opus" }, exposure).effort).toBe("medium");
    expect(decideGatewayRoutingAssignment({ surface: "stage", requestedEffort: "high" }, exposure).effort).toBe("medium");

    restarted.write({ models: [{ id, fast: true, efforts: ["low", "medium", "high"] }] });
    expect(buildGatewayCandidates(resolveAiGatewaySelection(restarted.read())).candidates[0]?.efforts).toEqual(["low", "medium", "high"]);
  });

  it("preserves explicit effort choices while the native ladder is unresolved across restarts", () => {
    const dataDir = createDataDir();
    const id = "claude--haiku-1m";
    const ladder = ["low", "medium", "high", "xhigh", "max"];
    const resolve = () => applyClaudeNativeModels([
      { value: "haiku[1m]", resolvedModel: "claude-haiku-5-5[1m]", displayName: "Haiku 5.5", effortLevels: ladder },
    ]);
    const store = createAiGatewaySettingsStore({ dataDir });
    store.seedModels([]);
    resolve();
    store.write({ models: [{ id, efforts: ["low", "medium"] }] });
    const chosen = [{ id, efforts: ["low", "medium"] }];

    // 재기동 직후에는 CLI 표가 없다. 현행판 시드도 저장을 거치므로 이때 선택을 지우면 안 된다.
    applyClaudeNativeModels([]);
    const restarted = createAiGatewaySettingsStore({ dataDir });
    expect(restarted.read().models).toEqual(chosen);
    expect(restarted.seedModels([])).toBe(false);
    restarted.writeWireLogEnabled(false);
    expect(JSON.parse(readFileSync(restarted.path, "utf-8")).models).toEqual(chosen);
    expect(normalizeAiGatewaySettings(restarted.read()).models).toEqual(chosen);

    resolve();
    expect(buildGatewayCandidates(resolveAiGatewaySelection(restarted.read())).candidates[0]?.efforts).toEqual(["low", "medium"]);
    // 사다리가 알려지면 없는 단계 제거와 전체 사다리의 키 생략은 종전처럼 적용한다.
    restarted.write({ models: [{ id, efforts: ["low", "medium", "retired"] }] });
    expect(restarted.read().models).toEqual(chosen);
    restarted.write({ models: [{ id, efforts: ladder }] });
    expect(restarted.read().models).toEqual([{ id }]);
  });

  it("stays unconfigured when the host directory holds nothing usable", () => {
    for (const seeded of [undefined, "{ not json", { version: 1 }, { version: 9, models: [{ id: "codex--gpt-6.1-sol" }] }]) {
      const dataDir = createDataDir();
      const legacyDir = path.join(dataDir, "previous-fleet");
      if (seeded !== undefined) {
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(
          path.join(legacyDir, "ai-gateway.json"),
          typeof seeded === "string" ? seeded : JSON.stringify(seeded),
          "utf-8",
        );
      }
      const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
      expect(store.read()).toEqual({ version: 1 });
      expect(existsSync(store.path)).toBe(false);
    }
  });

  // 승계는 모든 첫 쓰기 경로보다 앞서야 한다. 한 축만 갱신하는 PUT이 먼저 목적지 파일을
  // 만들어 버리면, 아직 옮기지 못한 나머지 축이 영영 고아가 된다.
  // `write`는 선별 자체를 교체하는 연산이므로 모델이 바뀌는 게 정상이다. 각 경로가 건드리지
  // **않는** 축이 승계된 값 그대로인지가 판정 기준이다.
  it("adopts remaining provider settings before a partial wire-log update", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, xaiEndpoint: "direct" });
    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    store.writeWireLogEnabled(true);
    expect(store.read()).toEqual({ version: 1, xaiEndpoint: "direct", wireLogEnabled: true });
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual(store.read());
    expect(existsSync(path.join(legacyDir, "ai-gateway.json"))).toBe(false);
  });

  it("retries adoption after a write it could not complete, instead of settling on the loss", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6.1-sol" }] });
    // 다른 프로세스가 락을 쥐고 있는 상태. staleLockMs를 크게 잡아 stale 회수 경로를 배제한다.
    const lockDir = path.join(dataDir, "ai-gateway.json.lock");
    mkdirSync(lockDir, { recursive: true });
    const store = createAiGatewaySettingsStore({
      dataDir,
      legacyDirs: [legacyDir],
      timeoutMs: 50,
      staleLockMs: 10 * 60 * 1000,
    });

    // 승계가 실패한다. 조용히 미구성으로 답하되, 목적지 파일을 만들어 결론을 굳혀선 안 된다.
    expect(store.read()).toEqual({ version: 1 });
    expect(existsSync(store.path)).toBe(false);

    rmSync(lockDir, { recursive: true, force: true });
    // 락이 풀린 뒤 한 축만 갱신해도 승계가 먼저 일어나야 한다.
    store.writeWireLogEnabled(true);
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6.1-sol" }],
      wireLogEnabled: true,
    });
  });

  it("refuses to write while the previous file exists but cannot be read yet", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6.1-sol" }] });
    const legacyFile = path.join(legacyDir, "ai-gateway.json");
    chmodSync(legacyFile, 0o000);
    // root는 권한 검사를 우회해 EACCES가 나지 않는다. 그 환경에서는 이 경로를 재현할 수 없다.
    let readable = true;
    try {
      readFileSync(legacyFile, "utf-8");
    } catch {
      readable = false;
    }
    if (readable) return;

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    // 읽기는 관대하다 — 미구성으로 답하되 목적지 파일을 만들어 결론을 굳히지 않는다.
    expect(store.read()).toEqual({ version: 1 });
    expect(existsSync(store.path)).toBe(false);
    // 쓰기는 거절한다. 여기서 파일이 생기면 그 순간 과거 선별이 영영 고아가 된다.
    expect(() => store.writeWireLogEnabled(true)).toThrow(/could not be read/);
    expect(existsSync(store.path)).toBe(false);

    chmodSync(legacyFile, 0o644);
    store.writeWireLogEnabled(true);
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6.1-sol" }],
      wireLogEnabled: true,
    });
  });

  it("does not wedge writes when the previous path can never yield a file", () => {
    const dataDir = createDataDir();
    // 그 자리에 디렉터리가 있으면 다시 읽어도 결과가 같다. 승계를 기다리며 저장을 영구히
    // 막는 것은 원래 막으려던 손실보다 나쁘므로, 결론(`nothing`)으로 접고 진행해야 한다.
    const legacyDir = path.join(dataDir, "previous-fleet");
    mkdirSync(path.join(legacyDir, "ai-gateway.json"), { recursive: true });
    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });

    store.writeWireLogEnabled(true);
    expect(store.read()).toEqual({ version: 1, wireLogEnabled: true });
  });

  it("cleans up its own orphaned temp files", () => {
    const dataDir = createDataDir();
    const store = createAiGatewaySettingsStore({ dataDir });
    store.write({ models: [{ id: "codex--gpt-6.1-sol" }] });
    // writeAtomicSync이 실제로 만드는 이름은 `<파일명>.<pid>.<ts>.<rand>.<host>.tmp`다.
    // 정리 접두가 그 규약과 어긋나면 고아 temp가 영원히 쌓인다.
    const orphan = `${store.path}.999.1.abc.host.tmp`;
    writeFileSync(orphan, "{}", "utf-8");
    utimesSync(orphan, new Date(0), new Date(0));

    store.writeWireLogEnabled(true);

    expect(existsSync(orphan)).toBe(false);
    // 같은 접두를 가진 락 디렉터리는 파일이 아니므로 정리 대상이 아니다.
    expect(store.read().wireLogEnabled).toBe(true);
  });
});

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

import { createAiGatewaySettingsStore } from "../../src/settings/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
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
  const legacyDir = path.join(root, "console", "plugins", "terminal");
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
    expect(store.read()).toEqual({ version: 1, providerPriority: ["codex"] });

    store.write({ models: [{ id: "opencode--glm-5.3" }] });
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "opencode--glm-5.3" }],
      providerPriority: ["codex"],
    });

    store.write({ providerPriority: [] });
    expect(store.read()).toEqual({ version: 1 });
  });

  it("persists compactCeiling independently of models", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    store.write({ models: [{ id: "opencode--glm-5.3" }] });
    store.writeCompactCeiling("early");
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "opencode--glm-5.3" }],
      compactCeiling: "early",
    });
    store.write({ models: [{ id: "codex--gpt-6-sol" }] });
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-sol" }],
      compactCeiling: "early",
    });
    store.writeCompactCeiling(94);
    expect(store.read()?.compactCeiling).toBe(94);
    store.writeCompactCeiling(undefined);
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-sol" }],
    });
  });

  it("persists xaiEndpoint independently of models", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    store.write({ models: [{ id: "opencode--glm-5.3" }] });
    store.writeXaiEndpoint("cli-proxy");
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "opencode--glm-5.3" }],
      xaiEndpoint: "cli-proxy",
    });
    // A models-only save must not silently move the endpoint back to the default.
    store.write({ models: [{ id: "codex--gpt-6-sol" }] });
    expect(store.read()?.xaiEndpoint).toBe("cli-proxy");
    store.writeXaiEndpoint(undefined);
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "codex--gpt-6-sol" }],
    });
  });

  it("keeps the wire-log choice independent of model selection", () => {
    const store = createAiGatewaySettingsStore({ dataDir: createDataDir() });
    store.write({ models: [{ id: "opencode--glm-5.3" }] });
    store.writeWireLogEnabled(false);
    expect(store.read()).toEqual({ version: 1, models: [{ id: "opencode--glm-5.3" }], wireLogEnabled: false });
    store.write(undefined);
    expect(store.read()).toEqual({ version: 1, wireLogEnabled: false });
    store.writeWireLogEnabled(undefined);
    expect(store.read()).toEqual({ version: 1 });
  });

  it("adopts the settings from the host directory it is given, without announcing it", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, {
      version: 1,
      models: [{ id: "opencode--muse-spark-1.3-contributor", efforts: ["high"] }, { id: "codex--gpt-6-sol" }],
      defaultModel: "codex--gpt-6-sol",
      wireLogEnabled: false,
    });
    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });

    // 레거시 defaultModel은 승계 시 조용히 버린다.
    expect(store.read()).toEqual({
      version: 1,
      models: [{ id: "opencode--muse-spark-1.3-contributor", efforts: ["high"] }, { id: "codex--gpt-6-sol" }],
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
      JSON.stringify({ version: 1, models: [{ id: "codex--gpt-6-sol" }] }),
      "utf-8",
    );

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [dataDir] });
    store.writeWireLogEnabled(true);

    expect(existsSync(store.path)).toBe(true);
    expect(store.read().models).toEqual([{ id: "codex--gpt-6-sol" }]);
  });

  it("performs no adoption when no host directory is given", () => {
    const dataDir = createDataDir();
    seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6-sol" }] });
    const store = createAiGatewaySettingsStore({ dataDir });

    expect(store.read()).toEqual({ version: 1 });
    expect(existsSync(store.path)).toBe(false);
  });

  it("never overwrites settings that already exist on the new axis", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6-sol" }] });
    createAiGatewaySettingsStore({ dataDir }).write({ models: [{ id: "opencode--glm-5.3" }] });

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    expect(store.read()).toEqual({ version: 1, models: [{ id: "opencode--glm-5.3" }] });
  });

  it("treats an emptied selection as a real state rather than something to re-adopt", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6-sol" }] });
    // 사용자가 전부 지운 상태. 정규형은 승계 전과 구분되지 않으므로 파일 존재로만 판정해야 한다.
    createAiGatewaySettingsStore({ dataDir }).write(undefined);

    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    expect(store.read()).toEqual({ version: 1 });
  });

  it("stays unconfigured when the host directory holds nothing usable", () => {
    for (const seeded of [undefined, "{ not json", { version: 1 }, { version: 9, models: [{ id: "codex--gpt-6-sol" }] }]) {
      const dataDir = createDataDir();
      const legacyDir = path.join(dataDir, "console", "plugins", "terminal");
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
    const legacyDir = seedLegacySettings(dataDir, { version: 1, cursorDiagnosticsEnabled: true, xaiEndpoint: "direct" });
    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });
    store.writeWireLogEnabled(true);
    expect(store.read()).toEqual({ version: 1, xaiEndpoint: "direct", wireLogEnabled: true });
    expect(JSON.parse(readFileSync(store.path, "utf-8"))).toEqual(store.read());
    expect(existsSync(path.join(legacyDir, "ai-gateway.json"))).toBe(false);
  });

  it("retries adoption after a write it could not complete, instead of settling on the loss", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6-sol" }] });
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
      models: [{ id: "codex--gpt-6-sol" }],
      wireLogEnabled: true,
    });
  });

  it("refuses to write while the previous file exists but cannot be read yet", () => {
    const dataDir = createDataDir();
    const legacyDir = seedLegacySettings(dataDir, { version: 1, models: [{ id: "codex--gpt-6-sol" }] });
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
      models: [{ id: "codex--gpt-6-sol" }],
      wireLogEnabled: true,
    });
  });

  it("does not wedge writes when the previous path can never yield a file", () => {
    const dataDir = createDataDir();
    // 그 자리에 디렉터리가 있으면 다시 읽어도 결과가 같다. 승계를 기다리며 저장을 영구히
    // 막는 것은 원래 막으려던 손실보다 나쁘므로, 결론(`nothing`)으로 접고 진행해야 한다.
    const legacyDir = path.join(dataDir, "console", "plugins", "terminal");
    mkdirSync(path.join(legacyDir, "ai-gateway.json"), { recursive: true });
    const store = createAiGatewaySettingsStore({ dataDir, legacyDirs: [legacyDir] });

    store.writeWireLogEnabled(true);
    expect(store.read()).toEqual({ version: 1, wireLogEnabled: true });
  });

  it("cleans up its own orphaned temp files", () => {
    const dataDir = createDataDir();
    const store = createAiGatewaySettingsStore({ dataDir });
    store.write({ models: [{ id: "codex--gpt-6-sol" }] });
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

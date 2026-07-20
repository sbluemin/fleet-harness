import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initStore,
  loadCarrierStates,
  resetStoreForTests,
} from "../../src/index.js";

// resolveSelectionForCliType의 Kimi 프로바이더 기본 모델 폴백 체인 검증.
// 전역 설정(settings.json)은 활성 store 디렉터리 기준이라 HOME을 임시 디렉터리로 격리한다.
describe("Kimi 프로바이더 기본 모델 폴백", () => {
  let tempHome: string | null = null;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-kimi-default-"));
    process.env.HOME = tempHome;
    resetStoreForTests();
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    resetStoreForTests();
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  });

  it("캐리어별/페르소나 기본 모델이 없으면 전역 설정의 Kimi 기본 모델을 사용한다", () => {
    writeSettingsJson({ version: 1, kimiModel: { model: "k3", effort: "low" } });

    const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "k3", effort: "low" });
  });

  it("전역 설정이 없으면 레지스트리 기본 모델로 폴백한다", () => {
    const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "kimi-for-coding" });
  });

  it("전역 설정 파일이 손상되면 레지스트리 기본 모델로 폴백한다", () => {
    fs.mkdirSync(path.join(tempHome!, ".fleet"), { recursive: true });
    fs.writeFileSync(path.join(tempHome!, ".fleet", "settings.json"), "{nope", "utf-8");

    const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "kimi-for-coding" });
  });

  it("전역 설정의 모델이 유효하지 않으면 레지스트리 기본 모델로 폴백한다", () => {
    writeSettingsJson({ version: 1, kimiModel: { model: "not-a-real-model", effort: "high" } });

    const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "kimi-for-coding" });
  });

  it("effort 미지원 모델이 전역 설정에 저장되면 effort를 생략한다", () => {
    writeSettingsJson({ version: 1, kimiModel: { model: "kimi-for-coding-highspeed", effort: "high" } });

    const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "kimi-for-coding-highspeed" });
  });

  it("유효한 캐리어별 선택은 전역 설정보다 우선한다", () => {
    writeSettingsJson({ version: 1, kimiModel: { model: "k3", effort: "low" } });
    writeCarriersJson({
      _meta: { generation: 1 },
      carriers: {
        ohio: {
          agentCliType: "claude-kimi",
          agentCli: { "claude-kimi": { model: "k3[1m]", effort: "max" } },
        },
      },
    });

    const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "k3[1m]", effort: "max" });
  });

  it("유효한 페르소나 기본 모델은 전역 설정보다 우선한다", () => {
    writeSettingsJson({ version: 1, kimiModel: { model: "k3", effort: "low" } });

    const states = loadCarrierStates({
      ohio: { cliType: "claude-kimi", defaultModel: "k3[1m]", defaultEffort: "max" },
    });

    expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "k3[1m]", effort: "max" });
  });

  it("Kimi가 아닌 CLI는 전역 설정의 kimiModel을 무시한다", () => {
    writeSettingsJson({ version: 1, kimiModel: { model: "k3", effort: "low" } });

    const states = loadCarrierStates({ ohio: { cliType: "codex" } });

    expect(states.ohio?.agentCli.codex).toEqual({ model: "gpt-5.6-sol", effort: "low" });
  });

  it("initStore로 재배치된 store 디렉터리의 전역 설정을 사용한다", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-kimi-custom-"));
    try {
      initStore(customDir);
      // 기본 디렉터리(HOME)에는 다른 값을 두고, 재배치된 디렉터리에 k3를 둔다.
      writeSettingsJson({ version: 1, kimiModel: { model: "kimi-for-coding-highspeed" } });
      fs.writeFileSync(
        path.join(customDir, "settings.json"),
        JSON.stringify({ version: 1, kimiModel: { model: "k3", effort: "low" } }),
        "utf-8",
      );

      const states = loadCarrierStates({ ohio: { cliType: "claude-kimi" } });

      expect(states.ohio?.agentCli["claude-kimi"]).toEqual({ model: "k3", effort: "low" });
    } finally {
      resetStoreForTests();
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  function writeSettingsJson(value: unknown): void {
    const dir = path.join(tempHome!, ".fleet");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(value), "utf-8");
  }

  function writeCarriersJson(value: unknown): void {
    const dir = path.join(tempHome!, ".fleet");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "carriers.json"), JSON.stringify(value), "utf-8");
  }
});

import { describe, expect, it } from "vitest";

import {
  buildKimiModelEnv,
  resolveKimiModelSelection,
  resolveKimiModelSelectionFromOverride,
} from "../src/agent-cli/kimi-model.js";

describe("resolveKimiModelSelectionFromOverride", () => {
  it("유효한 명시 모델/effort를 그대로 반환한다", () => {
    expect(resolveKimiModelSelectionFromOverride("k3[1m]", "max")).toEqual({ model: "k3[1m]", effort: "max" });
  });

  it("레지스트리에 없는 자유 형식 모델은 throw 없이 레지스트리 기본 모델로 폴백한다", () => {
    expect(resolveKimiModelSelectionFromOverride("kimi-next-gen")).toEqual({ model: "kimi-for-coding" });
  });
});

describe("resolveKimiModelSelection", () => {
  it("설정 서비스가 없으면 레지스트리 기본 모델을 반환한다", () => {
    expect(resolveKimiModelSelection(undefined)).toEqual({ model: "kimi-for-coding" });
  });

  it("저장된 유효한 모델/effort 선택을 반환한다", () => {
    const selection = resolveKimiModelSelection({
      load: () => ({ kimiModel: { model: "k3", effort: "max" } }),
    });

    expect(selection).toEqual({ model: "k3", effort: "max" });
  });

  it("저장된 모델이 유효하지 않으면 레지스트리 기본 모델로 폴백한다", () => {
    const selection = resolveKimiModelSelection({
      load: () => ({ kimiModel: { model: "not-a-model", effort: "high" } }),
    });

    expect(selection).toEqual({ model: "kimi-for-coding" });
  });

  it("effort 미지원 모델은 effort를 생략한다", () => {
    const selection = resolveKimiModelSelection({
      load: () => ({ kimiModel: { model: "kimi-for-coding-highspeed", effort: "high" } }),
    });

    expect(selection).toEqual({ model: "kimi-for-coding-highspeed" });
  });

  it("effort 지원 모델에 저장 effort가 없거나 무효하면 모델 기본 effort를 사용한다", () => {
    expect(resolveKimiModelSelection({
      load: () => ({ kimiModel: { model: "k3" } }),
    })).toEqual({ model: "k3", effort: "high" });
    expect(resolveKimiModelSelection({
      load: () => ({ kimiModel: { model: "k3", effort: "ultra" } }),
    })).toEqual({ model: "k3", effort: "high" });
  });

  it("설정 로드가 실패하면 레지스트리 기본 모델로 폴백한다", () => {
    const selection = resolveKimiModelSelection({
      load: () => {
        throw new Error("settings unavailable");
      },
    });

    expect(selection).toEqual({ model: "kimi-for-coding" });
  });
});

describe("buildKimiModelEnv", () => {
  it("모든 모델 슬롯을 선택 모델로 고정하고 262K 컨텍스트 env를 설정한다", () => {
    expect(buildKimiModelEnv({ model: "kimi-for-coding" })).toEqual({
      ANTHROPIC_MODEL: "kimi-for-coding",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-for-coding",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-for-coding",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-for-coding",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-for-coding",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-for-coding",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "262144",
    });
  });

  it("k3[1m]은 1M 컨텍스트 env와 effort를 설정한다", () => {
    expect(buildKimiModelEnv({ model: "k3[1m]", effort: "high" })).toEqual({
      ANTHROPIC_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "k3[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "k3[1m]",
      CLAUDE_CODE_SUBAGENT_MODEL: "k3[1m]",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1048576",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1048576",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    });
  });
});

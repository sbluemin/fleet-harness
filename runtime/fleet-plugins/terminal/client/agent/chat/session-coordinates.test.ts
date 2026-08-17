import { describe, expect, it } from "vitest";

import { readAgentChatSessionCoordinates } from "./session-coordinates.js";
import { EFFORT_LABELS, NATIVE_MODEL_LABELS } from "../../../server/agent-api/agent-cli-launch-kinds.js";

describe("agent chat session coordinates", () => {
  it("reads the launch coordinates the Operation payload carries", () => {
    const coordinates = readAgentChatSessionCoordinates({ launchModel: "opus[1m]", launchEffort: "ultra" });
    expect(coordinates).toEqual({
      model: "Opus",
      effort: "ULTRACODE",
      effortLevel: "ultra",
      title: "opus[1m] · ultra",
      ultracode: true,
    });
  });

  // 좌표가 없는 세션은 서버가 자기 기본값(`opus[1m]`)으로 이어 간다. 그 규칙을 여기서 복제하면
  // 서버가 기본을 바꾸는 날 이 표식만 조용히 거짓말한다 — 그래서 모델을 추측하지 않는다.
  it("never guesses the server's fallback model", () => {
    const coordinates = readAgentChatSessionCoordinates({});
    expect(coordinates.model).toBeNull();
    expect(coordinates.effort).toBeNull();
    expect(coordinates.effortLevel).toBe("auto");
    expect(coordinates.title).toBeNull();
    expect(coordinates.ultracode).toBe(false);
  });

  it("keeps the effort level even when only the effort was pinned", () => {
    const coordinates = readAgentChatSessionCoordinates({ launchEffort: "max" });
    expect(coordinates.model).toBeNull();
    expect(coordinates.effort).toBe("MAX");
    expect(coordinates.effortLevel).toBe("max");
    expect(coordinates.title).toBe("max");
  });

  it("shortens a scoped gateway model id to the model it names", () => {
    expect(readAgentChatSessionCoordinates({ launchModel: "cursor--auto" }).model).toBe("auto");
    expect(readAgentChatSessionCoordinates({ launchModel: "claude-gateway--xai--grok-4.6" }).model).toBe("grok-4.6");
  });

  it("ignores payload values that are not non-empty strings", () => {
    expect(readAgentChatSessionCoordinates({ launchModel: "", launchEffort: 3 as unknown as string }).title).toBeNull();
    expect(readAgentChatSessionCoordinates(undefined).title).toBeNull();
  });

  // 같은 세션을 두 표면이 다른 이름으로 부르면 사용자는 자기가 고른 것과 지금 도는 것을 대조하지
  // 못한다. 런치 메뉴가 어휘의 원본이므로, 칩이 그 표에서 갈라지면 여기서 붉어진다.
  it("speaks the launch menu's vocabulary", () => {
    for (const [model, label] of Object.entries(NATIVE_MODEL_LABELS)) {
      expect(readAgentChatSessionCoordinates({ launchModel: model }).model).toBe(label);
    }
    for (const [effort, label] of Object.entries(EFFORT_LABELS)) {
      expect(readAgentChatSessionCoordinates({ launchEffort: effort }).effort).toBe(label);
    }
  });
});

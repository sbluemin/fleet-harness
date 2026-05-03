import { beforeEach, describe, expect, it, vi } from "vitest";
import { admiral } from "@sbluemin/fleet-core";
import type { AgentCol } from "../../src/panel/types.js";
import { getState, makeFooterCols, resetPanelStateForTest } from "../../src/panel/state.js";

const { CARRIER_FRAMEWORK_KEY } = admiral.carrier;

function makeCol(cli: string, status: AgentCol["status"]): AgentCol {
  return {
    cli,
    sessionId: `${cli}-session`,
    text: "",
    blocks: [],
    thinking: "",
    toolCalls: [],
    status,
    scroll: 0,
  };
}

beforeEach(() => {
  resetPanelStateForTest();
  // carrier framework 상태를 테스트용으로 설정 (getRegisteredOrder 대응)
  (globalThis as any)[CARRIER_FRAMEWORK_KEY] = {
    modes: new Map(),
    registeredOrder: ["genesis", "sentinel", "vanguard"],
    statusUpdateCallbacks: [],
  };
});

describe("makeFooterCols", () => {
  it("부분 모드에서도 footer는 전체 CLI 슬롯을 유지한다", () => {
    const state = getState();
    state.cols = [
      makeCol("genesis", "stream"),
      makeCol("sentinel", "done"),
    ];

    const footerCols = makeFooterCols();

    expect(footerCols.map((col) => col.cli)).toEqual(["genesis", "sentinel", "vanguard"]);
    expect(footerCols[0]?.status).toBe("stream");
    expect(footerCols[1]?.status).toBe("done");
    expect(footerCols[2]?.status).toBe("wait");
    expect(footerCols[2]?.sessionId).toBeUndefined();
  });
});

import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { shouldShowWip } from "../client/history-panel.js";
import { resolveLogOrder } from "../server/log.js";

// 2026-08-05 재가 계약 — History는 체크아웃과 무관한 "저장소의 객관적 기록"이다.
// 체크아웃을 따라 움직여도 되는 표면은 정확히 두 개: is-off-head 텍스트 티어 강등과 WIP 행.
// 이 테스트는 그 불변식을 소스 계약으로 고정한다. 깨뜨리는 변경은 계약 개정을 명시하고 함께 갱신할 것.
const logSource = await fs.readFile(new URL("../server/log.ts", import.meta.url), "utf8");
const historyPanelSource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");

describe("History checkout-invariance contracts", () => {

  it("resolves the order axis through a closed whitelist that defaults to topological", () => {
    expect(resolveLogOrder(undefined)).toBe("topo");
    expect(resolveLogOrder("topo")).toBe("topo");
    expect(resolveLogOrder("date")).toBe("date");
    // 요청 문자열이 git 인자 위치에 직접 닿으면 안 된다 — 알아볼 수 없는 값은 인자가 아니라 거절이다.
    for (const rejected of ["--all", "reverse", "", 1, null, {}]) expect(resolveLogOrder(rejected)).toBeNull();
    expect(logSource).toContain('const LOG_ORDER_ARGS: Readonly<Record<LogOrder, string>> = { topo: "--topo-order", date: "--date-order" }');
  });
});

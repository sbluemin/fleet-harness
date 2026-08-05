import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { shouldShowWip } from "../client/history-panel.js";

// 2026-08-05 재가 계약 — History는 체크아웃과 무관한 "저장소의 객관적 기록"이다.
// 체크아웃을 따라 움직여도 되는 표면은 정확히 두 개: is-off-head 텍스트 티어 강등과 WIP 행.
// 이 테스트는 그 불변식을 소스 계약으로 고정한다. 깨뜨리는 변경은 계약 개정을 명시하고 함께 갱신할 것.
const logSource = await fs.readFile(new URL("../server/log.ts", import.meta.url), "utf8");
const cssSource = await fs.readFile(new URL("../client/repository.css", import.meta.url), "utf8");
const historyPanelSource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");

describe("History checkout-invariance contracts", () => {
  it("keeps the default log an all-refs date-ordered query, never scoped to the active branch", () => {
    expect(logSource).toContain('"log", "--branches", "--tags", "--remotes", "--date-order"');
  });

  it("keeps off-head dimming a text-tier demotion, not opacity", () => {
    expect(cssSource).toContain(".history-commit-row.is-off-head .history-commit-subject");
    expect(cssSource).toMatch(/is-off-head[\s\S]{0,400}?color: var\(--text-tertiary\)/);
    expect(cssSource).not.toMatch(/is-off-head[^}]*opacity/);
  });

  it("derives is-off-head solely from the server onHead annotation and labels it", () => {
    expect(historyPanelSource).toContain('${entry.onHead ? "" : " is-off-head"}');
    expect(historyPanelSource).toContain('t("repository.history.offHead")');
    expect(historyPanelSource).toContain('t("repository.history.countLegend")');
  });

  it("fails open when reachability cannot be computed — never dim on missing evidence", () => {
    expect(logSource).toContain("rev-list 실패/빈 결과(HEAD 부재 등)에서는 전체 dim을 피하기 위해 모두 도달 가능으로 둔다");
  });

  it("keeps the reachability walk depth tracking the loaded page depth", () => {
    expect(logSource).toContain("Math.max(1000, skip + limit + 800)");
  });

  it("keeps the WIP row as the only other checkout-relative surface, hidden under filters", () => {
    expect(shouldShowWip({ files: 2 }, "", null)).toBe(true);
    expect(shouldShowWip({ files: 0 }, "", null)).toBe(false);
    expect(shouldShowWip({ files: 2 }, "query", null)).toBe(false);
    expect(shouldShowWip({ files: 2 }, "", "refs/heads/main")).toBe(false);
  });
});

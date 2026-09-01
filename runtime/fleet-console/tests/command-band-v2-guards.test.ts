// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { OperationRuntimeState } from "../sdk/plugin/types.js";

import { commandBandCenterFits, commandBandCenterGutter, commandBandPulseCounts, commandBandPulseNames } from "../core/client/src/components/command-band-guards.js";
import type { OperationNode } from "../core/client/src/types.js";

describe("Command Band v2 guards", () => {
  it("disables Fit all panels until Operations hydrate", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");

    // Fit all은 Cruise 트레이에만 마운트되므로 모드 게이트는 더 이상 필요 없다 — hydrate 게이트만 남는다.
    expect(source).toContain("disabled={state.activeTheaterId === null || !state.operationsHydrated}");
    expect(source).not.toContain("|| triageActive ||");
  });
});

describe("Command Band breadcrumb retirement", () => {
  it("keeps the Theater/Operation switcher out of the band — the sidebar already says that sentence", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");
    const styles = readFileSync(resolve(process.cwd(), "core/client/src/styles/layout.css"), "utf8");

    for (const retired of [
      "command-band-switcher",
      "command-band-theater-cluster",
      "command-band-segment-trigger",
      "command-band-rename-input",
      "commandBandRenameCommitTarget",
      "commandBandActiveOperation",
      "CommandBandTheaterMenu",
      "CommandBandOperationMenu",
      "useInlineRename",
    ]) {
      expect(source).not.toContain(retired);
    }
    for (const retiredStyle of [
      ".command-band-switcher",
      ".command-band-theater-cluster",
      ".command-band-segment-trigger",
      ".command-band-menu",
      ".command-band-rename-input",
      ".command-band-operation-status",
    ]) {
      expect(styles).not.toContain(retiredStyle);
    }
  });

  it("mounts the map controls as the sole passenger of the center track", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");

    expect(source).toContain(`      <div className="command-band-center">
        {operationsViewVisible ? <div ref={mapControlsRef} className="command-band-map-controls">`);
  });
});

describe("Command Band center visibility measurements", () => {
  it("uses the floor gutter while both clusters are unmeasured", () => {
    expect(commandBandCenterGutter(0, 0)).toBe(44);
    expect(commandBandCenterGutter(-1, -1)).toBe(44);
  });

  it("derives the gutter from the wider of the two measured clusters", () => {
    expect(commandBandCenterGutter(163, 0)).toBe(163 + 12);
    // 우측 클러스터가 더 넓으면 하한은 우측이 정한다 — 한쪽만 예약하면 중앙이 우측과 겹친다.
    expect(commandBandCenterGutter(163, 240)).toBe(240 + 12);
    // 사이드바 폭은 하한과 무관하다 — 부유 카드로 내려간 사이드바는 밴드 좌표계의 일부가 아니다.
    expect(commandBandCenterGutter(320, 0)).toBe(320 + 12);
    // 클러스터가 하한(44)보다 좁아도 바닥은 유지된다.
    expect(commandBandCenterGutter(20, 20)).toBe(44);
  });

  it("keeps the center centered while the band or its content is unmeasured", () => {
    expect(commandBandCenterFits(0, 183, 290)).toBe(true);
    expect(commandBandCenterFits(-1, 183, 290)).toBe(true);
    expect(commandBandCenterFits(1280, 183, 0)).toBe(true);
  });

  it("requires the two gutters plus the natural width of the mode controls", () => {
    const gutter = 183;
    expect(commandBandCenterFits(gutter * 2 + 290, gutter, 290)).toBe(true);
    // 모자라면 감추는 대신 좌측 플로우로 되돌린다 — 모드 스위치는 접을 수 없다.
    expect(commandBandCenterFits(gutter * 2 + 290 - 1, gutter, 290)).toBe(false);
  });
});

describe("Command Band pulse capsules (read-only, phase 1)", () => {
  const op = (id: string, title: string, payload: Record<string, unknown> = {}): OperationNode => ({
    id,
    theaterId: `theater-${id}`,
    type: "agent",
    pluginId: "terminal",
    title,
    payload,
    geometry: null,
    ts: { createdAt: 1, updatedAt: 1 },
  });
  const live = (activity: "idle" | "running" | "awaiting" | "background"): OperationRuntimeState => ({ lifecycle: "live", activity });

  it("counts the raw activity ledger without promotion or merging", () => {
    const runtime: Record<string, OperationRuntimeState> = {
      a: live("running"),
      b: live("running"),
      c: live("awaiting"),
      // background는 running에 합치지 않는다 — 사이드바 상태축과 숫자가 갈라진다.
      d: live("background"),
      e: live("idle"),
      f: { lifecycle: "dormant" },
    };
    const counts = commandBandPulseCounts(
      [op("a", "codex-review"), op("b", "doc-sweep"), op("c", "seed-op-2"), op("d", "bg-sweep"), op("e", "idle-op"), op("f", "gone-op")],
      runtime,
    );
    expect(counts.running).toEqual(["codex-review", "doc-sweep"]);
    expect(counts.awaiting).toEqual(["seed-op-2"]);
  });

  it("treats unobserved and restored-dormant operations as non-signal", () => {
    // 런타임 미관측 = idle 폴백, 복원 마커 = ended — 어느 쪽도 캡슐에 오르지 않는다.
    const counts = commandBandPulseCounts(
      [op("x", "fresh-op"), op("y", "restored-op", { restoredDormant: true }), op("z", "resumable-op", { resumeAvailable: true })],
      {},
    );
    expect(counts.running).toEqual([]);
    expect(counts.awaiting).toEqual([]);
  });

  it("crosses theaters — capsules aggregate the whole fleet like the War Room queue", () => {
    const counts = commandBandPulseCounts(
      [op("a", "alpha"), op("b", "beta")],
      { a: live("awaiting"), b: live("awaiting") },
    );
    expect(counts.awaiting).toEqual(["alpha", "beta"]);
  });

  it("folds the tooltip name list at four titles", () => {
    expect(commandBandPulseNames(["a", "b"])).toBe("a, b");
    expect(commandBandPulseNames(["a", "b", "c", "d", "e"])).toBe("a, b, c, d…");
  });

  it("keeps the capsules wordless and read-only in the band source", () => {
    const source = readFileSync(resolve(process.cwd(), "core/client/src/components/command-band.tsx"), "utf8");

    // 낱말(RUNNING/AWAITING)은 화면에 싣지 않는다 — 비콘+숫자, 이름은 title·aria-label로.
    expect(source).toContain('<span className="tenant-beacon is-turn-running" aria-hidden="true" />');
    expect(source).toContain('<span className="tenant-beacon is-awaiting" aria-hidden="true" />');
    expect(source).toContain("{pulse.running.length}");
    expect(source).toContain("{pulse.awaiting.length}");
    // 읽기 전용 — 클릭 문(상태 응답 진입)은 2단계 재가 전까지 달지 않는다.
    expect(source).not.toMatch(/command-band-pulse[^\n]*onClick/);
    // 0건 캡슐은 부재다 — 빈 숫자는 소음이다.
    expect(source).toContain("{pulse.running.length > 0 || pulse.awaiting.length > 0 ?");
  });
});

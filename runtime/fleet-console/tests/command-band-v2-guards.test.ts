// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { commandBandCenterFits, commandBandCenterGutter } from "../core/client/src/components/command-band-guards.js";

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

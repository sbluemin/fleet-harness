import { beforeEach, describe, expect, it, vi } from "vitest";

const drawsText = vi.fn<(family: string, probe: string, options?: { baselineFamily?: string }) => boolean>();
const probeOrder: string[] = [];
let releaseFallbackFonts: (() => void) | null = null;

// 나머지 export(체인 조립에 쓰이는 sanitize/quote 등)는 진짜를 남긴다 — 통째로 갈면 선호 모듈이 부팅에서 죽는다.
vi.mock("@fleet-console/font-picker/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fleet-console/font-picker/resolve")>()),
  fontDrawsText: (family: string, probe: string, options?: { baselineFamily?: string }) => {
    probeOrder.push("probe");
    return drawsText(family, probe, options);
  },
}));

vi.mock("../client/shared/terminal-fallback-fonts.js", () => ({
  waitForTerminalFallbackFonts: () => new Promise<void>((resolve) => {
    releaseFallbackFonts = () => { probeOrder.push("fonts-ready"); resolve(); };
  }),
}));

const { CJK_SCRIPTS, fontCjkScripts } = await import("../client/shared/cjk-coverage.js");

describe("CJK coverage probe", () => {
  beforeEach(() => {
    drawsText.mockReset();
    probeOrder.length = 0;
    releaseFallbackFonts = null;
  });

  /* 판정의 기준선은 번들 서체다. 그것이 로드되기 전에 물으면 기준선이 OS 폴백으로 주저앉아 답이
     뒤집히고, 탐침 캐시가 그 오답을 굳혀 이후 올바른 호출까지 오염된다. 그래서 대기는 호출자의
     규율이 아니라 이 함수의 계약이어야 한다 — 이 테스트가 그 계약을 잡는다. */
  it("asks nothing until the bundled baseline face has loaded", async () => {
    drawsText.mockReturnValue(true);
    const pending = fontCjkScripts("D2Coding");
    await Promise.resolve();

    expect(probeOrder).toEqual([]);

    releaseFallbackFonts?.();
    await pending;

    expect(probeOrder[0]).toBe("fonts-ready");
    expect(probeOrder.filter((entry) => entry === "probe")).toHaveLength(CJK_SCRIPTS.length);
  });

  it("reports only the scripts the family draws, and pins the bundled face as the baseline", async () => {
    drawsText.mockImplementation((_family, probe) => probe.includes("한"));
    const pending = fontCjkScripts("Nanum Gothic Coding");
    releaseFallbackFonts?.();

    expect(await pending).toEqual(["hangul"]);
    for (const call of drawsText.mock.calls) {
      expect(call[2]).toEqual({ baselineFamily: "Nanum Gothic Coding" });
    }
  });

  it("returns an empty list for a Latin-only family", async () => {
    drawsText.mockReturnValue(false);
    const pending = fontCjkScripts("Fira Code Variable");
    releaseFallbackFonts?.();

    expect(await pending).toEqual([]);
  });
});

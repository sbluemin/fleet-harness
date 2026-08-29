import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeFontFaceSet {
  readonly load: (spec: string, text?: string) => Promise<readonly unknown[]>;
  readonly calls: { spec: string; text?: string }[];
}

function installFontFaceSet(loader: (spec: string, text?: string) => Promise<readonly unknown[]>): FakeFontFaceSet {
  const calls: { spec: string; text?: string }[] = [];
  const fonts: FakeFontFaceSet = {
    calls,
    load: (spec, text) => {
      calls.push({ spec, text });
      return loader(spec, text);
    },
  };
  vi.stubGlobal("document", { fonts });
  return fonts;
}

async function loadModule() {
  vi.resetModules();
  return import("../client/shared/terminal-fallback-fonts.js");
}

describe("terminal fallback fonts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the bundled CJK baseline as ready only after its face actually arrives", async () => {
    installFontFaceSet(async (spec) => (spec.includes("Nanum Gothic Coding") ? [{}] : []));
    const module = await loadModule();

    expect(module.cjkFallbackBaselineReady()).toBe(false);
    await module.preloadTerminalFallbackFonts();
    expect(module.cjkFallbackBaselineReady()).toBe(true);
  });

  /* 세트에 이름이 아예 없으면 load()는 거절하지 않고 빈 배열로 끝난다 — 스타일 청크가 실려오지
     못했거나 가족명이 어긋난 경우다. 기준선이 통째로 사라진 그 상태를 준비됨으로 읽으면, 커버리지
     판정이 OS 폴백을 기준선 삼아 내려지고 그대로 캐시에 굳는다. */
  it("stays unready when the baseline family resolves to no face at all", async () => {
    installFontFaceSet(async () => []);
    const module = await loadModule();

    await module.preloadTerminalFallbackFonts();
    expect(module.cjkFallbackBaselineReady()).toBe(false);
  });

  it("stays unready when the baseline face fails to load", async () => {
    installFontFaceSet(async (spec) => {
      if (spec.includes("Nanum Gothic Coding")) throw new Error("network");
      return [{}];
    });
    const module = await loadModule();

    await module.preloadTerminalFallbackFonts();
    expect(module.cjkFallbackBaselineReady()).toBe(false);
  });

  it("stays unready without a document, and never blocks the boot wait on it", async () => {
    vi.stubGlobal("document", undefined);
    const module = await loadModule();

    await module.waitForTerminalFallbackFonts();
    expect(module.cjkFallbackBaselineReady()).toBe(false);
  });

  /* 한글 서브셋은 unicode-range 없는 통짜 얼굴이라, 텍스트를 주지 않으면 매칭이 공백만으로 끝나
     정작 한글 글리프를 받지 못하는 판본이 있다. 굵기 두 벌 모두 대표 음절을 실어 보낸다. */
  it("asks for the Korean face with probe text at both weights", async () => {
    const fonts = installFontFaceSet(async () => [{}]);
    const module = await loadModule();
    await module.preloadTerminalFallbackFonts();

    const korean = fonts.calls.filter((call) => call.spec.includes("Nanum Gothic Coding"));
    expect(korean.map((call) => call.spec)).toEqual(['1em "Nanum Gothic Coding"', 'bold 1em "Nanum Gothic Coding"']);
    for (const call of korean) expect(call.text).toBe("한글");
  });
});

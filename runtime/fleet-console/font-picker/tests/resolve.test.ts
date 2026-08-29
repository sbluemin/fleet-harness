import { describe, expect, it, vi } from "vitest";

import { clearFontResolutionCache, fontDrawsText, fontResolves, quoteFontFamily, sanitizeFontFamilyName, withFontFallback } from "../resolve.js";

const RESOLVED_DOCUMENT = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText() { return { width: this.font.includes("Resolved") ? 200 : 100 }; },
    }),
  }),
} as unknown as Document;

const FALLBACK_DOCUMENT = {
  createElement: () => ({
    getContext: () => ({
      font: "",
      measureText: (text: string) => ({ width: text.length }),
    }),
  }),
} as unknown as Document;

describe("font resolution helpers", () => {
  it("quotes families and rejects empty or hostile names", () => {
    expect(quoteFontFamily('A\\B"C')).toBe('"A\\\\B\\"C"');
    expect(sanitizeFontFamilyName(" \u0000 Inter \u007f")).toBe("Inter");
    expect(withFontFallback("", "sans-serif")).toBe("sans-serif");
  });

  it("handles resolved, fallback, SSR, and unavailable canvas cases", () => {
    clearFontResolutionCache();
    expect(fontResolves("Resolved", { document: RESOLVED_DOCUMENT })).toBe(true);
    clearFontResolutionCache();
    expect(fontResolves("Fallback", { document: FALLBACK_DOCUMENT })).toBe(false);
    expect(fontResolves("", { document: FALLBACK_DOCUMENT })).toBe(false);
    expect(fontResolves("No canvas", { document: { createElement: () => ({ getContext: () => null }) } as unknown as Document })).toBe(false);
    vi.stubGlobal("document", undefined);
    expect(fontResolves("No document")).toBe(false);
    vi.unstubAllGlobals();
  });
});

/* 커버리지 탐침을 흉내내는 캔버스. 실제 브라우저에서 일어나는 일을 그대로 모형화한다: 체인 앞쪽에
   글리프를 가진 서체가 있으면 그 서체가 그리고, 없으면 뒤로 밀려 결국 같은 폴백이 그린다. 그래서
   래스터는 "실제로 그린 서체"의 지문이 된다. */
function createCoverageDocument(coverage: Readonly<Record<string, readonly string[]>>): { document: Document; readonly reads: () => number } {
  let reads = 0;
  const document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        font: "",
        textBaseline: "",
        fillStyle: "",
        clearRect() { /* no-op */ },
        fillText() { /* no-op */ },
        getImageData(this: { font: string }, _x: number, _y: number, width: number, height: number) {
          reads += 1;
          const families = [...this.font.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
          const drawn = families.find((family) => (coverage[family] ?? []).includes(PROBE)) ?? "os-fallback";
          const data = new Uint8ClampedArray(width * height * 4);
          for (let index = 0; index < data.length; index += 1) data[index] = drawn.charCodeAt(index % drawn.length) & 0xff;
          return { data };
        },
      }),
    }),
  } as unknown as Document;
  return { document, reads: () => reads };
}

const PROBE = "한글";

describe("glyph coverage probe", () => {
  it("separates a family that draws the probe from one that falls through to the baseline", () => {
    clearFontResolutionCache();
    const { document } = createCoverageDocument({ "Apple SD Gothic Neo": [PROBE], "Nanum Gothic Coding": [PROBE] });

    expect(fontDrawsText("Apple SD Gothic Neo", PROBE, { document, baselineFamily: "Nanum Gothic Coding" })).toBe(true);
    expect(fontDrawsText("Fira Code", PROBE, { document, baselineFamily: "Nanum Gothic Coding" })).toBe(false);
  });

  /* 기준선을 소비자가 지정하는 이유가 여기 있다. 기본 기준선(존재하지 않는 서체 → OS 폴백)으로는
     후보가 그 계열의 OS 폴백 서체 자신일 때 같은 픽셀이 나와 "글리프 없음"으로 오판한다. */
  it("stops the OS fallback family from reading as uncovered once a baseline family is supplied", () => {
    clearFontResolutionCache();
    const { document } = createCoverageDocument({ "os-fallback": [PROBE], "Nanum Gothic Coding": [PROBE] });

    expect(fontDrawsText("os-fallback", PROBE, { document })).toBe(false);
    clearFontResolutionCache();
    expect(fontDrawsText("os-fallback", PROBE, { document, baselineFamily: "Nanum Gothic Coding" })).toBe(true);
  });

  it("draws the baseline once across many candidates and remembers each verdict", () => {
    clearFontResolutionCache();
    const { document, reads } = createCoverageDocument({ "Nanum Gothic Coding": [PROBE], "D2Coding": [PROBE] });

    fontDrawsText("D2Coding", PROBE, { document, baselineFamily: "Nanum Gothic Coding" });
    const afterFirst = reads();
    fontDrawsText("Fira Code", PROBE, { document, baselineFamily: "Nanum Gothic Coding" });
    fontDrawsText("D2Coding", PROBE, { document, baselineFamily: "Nanum Gothic Coding" });

    expect(afterFirst).toBe(2);
    // 두 번째 후보는 자기 래스터만 그리고(기준선 재사용), 세 번째 호출은 캐시라 아무것도 그리지 않는다.
    expect(reads()).toBe(3);
  });

  it("refuses to answer without a document, a canvas, a family, or a probe", () => {
    clearFontResolutionCache();
    const { document } = createCoverageDocument({});
    expect(fontDrawsText("", PROBE, { document })).toBe(false);
    expect(fontDrawsText("Any", "  ", { document })).toBe(false);
    expect(fontDrawsText("Any", PROBE, { document: { createElement: () => ({ getContext: () => null }) } as unknown as Document })).toBe(false);
    vi.stubGlobal("document", undefined);
    expect(fontDrawsText("Any", PROBE)).toBe(false);
    vi.unstubAllGlobals();
  });
});

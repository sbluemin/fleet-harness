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

describe("coverage probe caching", () => {
  /* 기준선 서체가 준비되지 않은 채 내린 판정은 기준선이 OS 폴백으로 주저앉은 상태의 답이다. 판정도
     기준선 래스터도 남기지 않아야 다음 호출이 스스로 바로잡는다 — 래스터만 남겨도 오염은 그대로 번진다. */
  it("leaves neither the verdict nor the baseline raster behind when caching is refused", () => {
    clearFontResolutionCache();
    const { document, reads } = createCoverageDocument({ "Nanum Gothic Coding": [PROBE], "D2Coding": [PROBE] });
    const options = { document, baselineFamily: "Nanum Gothic Coding", cache: false } as const;

    expect(fontDrawsText("D2Coding", PROBE, options)).toBe(true);
    const afterFirst = reads();
    expect(fontDrawsText("D2Coding", PROBE, options)).toBe(true);

    // 기억한 것이 없으므로 두 번째 호출이 기준선과 후보를 다시 그린다.
    expect(afterFirst).toBe(2);
    expect(reads()).toBe(4);
  });

  it("still reads a verdict an earlier trusted call remembered", () => {
    clearFontResolutionCache();
    const { document, reads } = createCoverageDocument({ "Nanum Gothic Coding": [PROBE], "D2Coding": [PROBE] });

    expect(fontDrawsText("D2Coding", PROBE, { document, baselineFamily: "Nanum Gothic Coding" })).toBe(true);
    const afterTrusted = reads();
    expect(fontDrawsText("D2Coding", PROBE, { document, baselineFamily: "Nanum Gothic Coding", cache: false })).toBe(true);

    expect(reads()).toBe(afterTrusted);
  });
});

/* 캐시 키 구분자를 소스에 그대로 박으면 git이 이 파일을 바이너리로 분류해 diff가 `Binary files differ`
   로만 나온다. 리뷰도 병합도 불가능해지는데 화면상으로는 아무 흔적이 없어, 바이트로 잡는다. */
describe("source hygiene", () => {
  it("keeps every font-picker source file free of raw control bytes", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    // jsdom에서는 import.meta.url이 file: 스킴이 아니다. vitest는 패키지 루트를 cwd로 잡는다.
    const directory = `${process.cwd()}/`;
    const sources = readdirSync(directory).filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));

    // 잘못된 디렉터리를 훑어 통과가 공허해지는 것을 막는다.
    expect(sources).toContain("resolve.ts");
    for (const name of sources) {
      const bytes = readFileSync(`${directory}${name}`);
      const control = [...bytes].filter((byte) => byte < 9 || (byte > 13 && byte < 32));
      expect({ name, control }).toEqual({ name, control: [] });
    }
  });
});

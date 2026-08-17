import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.dirname(here);

function read(relative: string): string {
  return readFileSync(path.join(consoleRoot, relative), "utf8");
}

function specifiersIn(source: string, pattern: RegExp): readonly string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] as string).sort();
}

/**
 * 플러그인 shim은 세 곳이 같은 specifier 집합을 말해야 성립한다 — 호스트의 정의, 브라우저
 * 런타임 네임스페이스, 그리고 키 생성기. 하나만 빠져도 외부 플러그인은 로드 시점에 죽고,
 * 그 사실은 외부 플러그인을 실제로 설치해 보기 전까지 드러나지 않는다. 실제로 이 계약은
 * SDK subpath를 추가하면서 정의만 올리고 런타임을 비워 두는 방식으로 깨졌다.
 */
describe("plugin shim registry", () => {
  const pluginHost = read("core/host/plugin-host/plugin-host.ts");
  const main = read("core/client/src/main.tsx");
  const generator = readFileSync(path.join(path.dirname(path.dirname(consoleRoot)), "scripts", "generate-fleet-console-shim-keys.mjs"), "utf8");

  const defined = specifiersIn(pluginHost, /\{ name: "[^"]+", specifier: "([^"]+)"/gu);
  const runtime = specifiersIn(main, /^\s+"([^"]+)": \w+,$/gmu);
  const generated = specifiersIn(generator, /\["([^"]+)",\s*(?:null|path\.join)/gu);

  it("defines at least the SDK browser surfaces plus React", () => {
    expect(defined.length).toBeGreaterThanOrEqual(7);
    expect(defined).toContain("@fleet-console/sdk/components/failure-notice");
    expect(defined).toContain("@fleet-console/sdk/components/effort-track");
    expect(defined).toContain("@fleet-console/sdk/components/launch-provider-glyphs");
  });

  it("serves every defined shim from the browser runtime namespace", () => {
    // 정의만 있고 런타임에 없으면 renderShim이 "runtime shim unavailable"로 던진다.
    expect(runtime).toEqual(defined);
  });

  it("generates named exports for every defined shim", () => {
    // 생성기에 없으면 namedExports가 비어, 이름을 꺼내 쓰는 import가 조용히 undefined가 된다.
    expect(generated).toEqual(defined);
  });
});

import { defineConfig } from "tsup";

export default defineConfig({
  /**
   * 번들에 접혀 들어온 CommonJS 의존성(electron-updater가 끌고 오는 fs 계열)은 모듈 몸통에서
   * `require("fs")`를 실행한다. ESM 출력에는 `require`가 없어 esbuild의 심이 그 자리에서 던지므로,
   * 진입부에 진짜 `require`를 세워 둔다 — 이것이 없으면 빌드는 통과하고 실행이 첫 줄에서 깨진다.
   */
  banner: { js: 'import { createRequire as __fleetCreateRequire } from "node:module";\nconst require = __fleetCreateRequire(import.meta.url);' },
  clean: true,
  dts: false,
  entry: { main: "src/main.ts" },
  external: ["electron"],
  format: ["esm"],
  noExternal: [/^@fleet-console\/protocol(\/|$)/],
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  sourcemap: false,
  splitting: false,
  target: "node22",
});

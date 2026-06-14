import { defineConfig } from "tsup";

// dist/client(vite 산출물)을 보존해야 하므로 clean을 끈다 — dist/cli.*만 이 빌드의 소유다.
export default defineConfig([
  {
    entry: { cli: "src/cli.ts", "cli-bin": "src/cli-bin.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    dts: true,
    sourcemap: false,
    clean: false,
    // workspace 패키지(@dotobokuri/*)는 npm에 개별 발행하지 않으므로 번들에 인라인한다.
    // native(node-pty)·동적 require(ws)는 정적 분석 대상이 아니라 external로 남으며,
    // publish 스크립트가 이 둘만 dependencies로 유지한다.
    noExternal: [/^@dotobokuri\//],
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);

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
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);

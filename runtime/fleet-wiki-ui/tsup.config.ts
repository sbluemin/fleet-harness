import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

// 빌드 시 package.json 버전을 __PKG_VERSION__으로 주입한다 (/api/health의 version 필드).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    entry: {
      server: "src/server.ts"
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
    noExternal: [/^@dotobokuri\//],
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: {
      cli: "src/cli.ts"
    },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    dts: true,
    sourcemap: false,
    clean: false,
    noExternal: [/^@dotobokuri\//],
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);

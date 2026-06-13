import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    entry: { index: "src/index.ts", server: "src/server.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: false,
    clean: false,
    define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: { "cli-bin": "src/cli-bin.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    dts: false,
    sourcemap: false,
    clean: false,
    define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
    splitting: false,
    treeshake: true,
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);

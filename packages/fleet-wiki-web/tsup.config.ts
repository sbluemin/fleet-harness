import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      server: "src/server.ts"
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    target: "node18",
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
    splitting: false,
    treeshake: true,
    target: "node18",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);

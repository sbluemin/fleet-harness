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
    noExternal: [/^@dotobokuri\/fleet-/],
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
    noExternal: [/^@dotobokuri\/fleet-/],
    splitting: false,
    treeshake: true,
    target: "node18",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
  },
]);

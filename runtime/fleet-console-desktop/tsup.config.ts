import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: false,
  entry: { main: "src/main.ts" },
  external: ["electron", "electron-updater"],
  format: ["esm"],
  noExternal: ["@dotobokuri/fleet-console/desktop-protocol"],
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  sourcemap: false,
  splitting: false,
  target: "node22",
});

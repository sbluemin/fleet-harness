import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: [
    "@sbluemin/fleet-coding-agent",
    "@sbluemin/fleet-ai",
    "@sbluemin/fleet-tui",
    "@xterm/addon-serialize",
    "@xterm/headless",
    "node-pty"
  ],
});

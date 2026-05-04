import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  external: [
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-ai",
    "@mariozechner/pi-tui",
    "@xterm/addon-serialize",
    "@xterm/headless",
    "node-pty"
  ]
});

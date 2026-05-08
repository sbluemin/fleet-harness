import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const BRAND_THEME_SOURCE_DIR = join(ROOT_DIR, "src", "branding", "themes");
const BRAND_THEME_DIST_DIR = join(ROOT_DIR, "dist", "themes");

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
  ],
  onSuccess: async () => {
    mkdirSync(BRAND_THEME_DIST_DIR, { recursive: true });
    cpSync(BRAND_THEME_SOURCE_DIR, BRAND_THEME_DIST_DIR, { recursive: true });
  },
});

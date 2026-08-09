import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "claude/index": "src/claude/index.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "data-dir/paths": "src/data-dir/paths.ts",
    "fs-store": "src/fs-store/index.ts",
    "workspace-dir/workspace-dir": "src/workspace-dir/workspace-dir.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

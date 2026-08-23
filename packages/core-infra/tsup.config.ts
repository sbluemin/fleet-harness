import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "data-dir/paths": "src/data-dir/paths.ts",
    "data-dir/settings/store": "src/data-dir/settings/store.ts",
    "fs-store": "src/fs-store/index.ts",
    "workspace-dir/workspace-dir": "src/workspace-dir/workspace-dir.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

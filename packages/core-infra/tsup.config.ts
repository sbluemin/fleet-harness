import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    auth: "src/auth/index.ts",
    "data-dir": "src/data-dir/index.ts",
    "data-dir/settings": "src/data-dir/settings/index.ts",
    "fs-store": "src/fs-store/index.ts",
    "workspace-dir": "src/workspace-dir/index.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

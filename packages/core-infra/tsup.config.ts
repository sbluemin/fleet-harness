import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    auth: "src/auth/index.ts",
    "data-dir": "src/data-dir/index.ts",
    "global-options": "src/global-options/index.ts",
    "fs-store": "src/fs-store/index.ts",
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

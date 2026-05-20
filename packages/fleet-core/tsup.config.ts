import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    admiral: "src/admiral/index.ts",
    admiralty: "src/admiralty/index.ts",
    infra: "src/infra/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

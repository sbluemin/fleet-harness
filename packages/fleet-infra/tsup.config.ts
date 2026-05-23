import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    agent: "src/agent/index.ts",
    auth: "src/auth/index.ts",
    "data-dir": "src/data-dir/index.ts",
    job: "src/job/index.ts",
    log: "src/log/index.ts",
    settings: "src/settings/index.ts"
  },
  format: ["esm", "cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

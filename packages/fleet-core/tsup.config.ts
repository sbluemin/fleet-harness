import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    constants: "src/constants.ts",
    job: "src/services/job/index.ts",
    "admiral/carrier": "src/admiral/carrier/index.ts",
    "admiral/carrier/status-overlay-controller": "src/admiral/carrier/status-overlay-controller.ts",
    "admiral/carrier/types": "src/admiral/carrier/types.ts",
    "admiral/carrier/personas": "src/admiral/carrier/personas/index.ts",
    "admiral/squadron": "src/admiral/squadron/index.ts",
    "admiral/taskforce": "src/admiral/taskforce/index.ts",
    "carrier-jobs": "src/admiral/carrier-jobs/index.ts",
    "admiral/store": "src/admiral/store/index.ts",
    admiralty: "src/admiralty/index.ts",
    "admiral/_shared/carrier-job-events": "src/admiral/_shared/carrier-job-events.ts",
    admiral: "src/admiral/index.ts",
    "admiral/protocols/standing-orders": "src/admiral/protocols/standing-orders/index.ts",
    "services/tool-registry": "src/services/tool-registry/index.ts",
    metaphor: "src/metaphor/index.ts",
    "metaphor/operation-name": "src/metaphor/operation-name/index.ts",
    "metaphor/directive-refinement": "src/metaphor/directive-refinement/index.ts",
    "services/settings": "src/services/settings/index.ts",
    "services/log": "src/services/log/index.ts",
    "services/data-dir": "src/services/data-dir/index.ts"
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022"
});

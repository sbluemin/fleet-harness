import { definePlugin, registerLaunchCatalog } from "@fleet-console/sdk/plugin/node";

import { createBenchStore } from "./server/bench-store.js";
import { registerBenchRoutes } from "./server/bench-routes.js";

const BENCH_PLUGIN_ID = "bench";
const BENCH_OPERATION_TYPE = "bench";
const BENCH_SENSITIVE_FIELDS = ["initialPrompt", "contenders"] as const;

export default definePlugin({
  id: BENCH_PLUGIN_ID,
  name: "Eval Bench",
  register(ctx) {
    ctx.host.operations.registerOperationType(BENCH_OPERATION_TYPE);
    ctx.host.operations.registerPayloadSanitizer(BENCH_PLUGIN_ID, BENCH_SENSITIVE_FIELDS);
    registerLaunchCatalog(ctx, () => [{ id: BENCH_PLUGIN_ID, type: BENCH_OPERATION_TYPE, title: "Eval Bench" }]);
    const store = createBenchStore(ctx.host.storage);
    registerBenchRoutes(ctx, store);
  },
});

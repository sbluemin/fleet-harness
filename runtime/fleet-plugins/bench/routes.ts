import { definePlugin, registerLaunchCatalog } from "@fleet-console/sdk/plugin/node";

import { createBenchStore } from "./server/bench-store.js";
import { registerBenchRoutes } from "./server/bench-routes.js";

const BENCH_PLUGIN_ID = "bench";
const BENCH_OPERATION_TYPE = "bench";

export default definePlugin({
  id: BENCH_PLUGIN_ID,
  name: "Eval Bench",
  register(ctx) {
    ctx.host.operations.registerOperationType(BENCH_OPERATION_TYPE);
    // bench op payload는 의도적으로 민감 필드를 싣지 않는다(rubric·groupId·참전자 op id뿐).
    // initialPrompt는 bench store에만 저장되고 bench 라우트로만 서빙된다 — 존재하지 않는
    // 필드를 sanitizer에 선언하면 보호되고 있다는 착시만 만든다.
    registerLaunchCatalog(ctx, () => [{ id: BENCH_PLUGIN_ID, type: BENCH_OPERATION_TYPE, title: "Eval Bench" }]);
    const store = createBenchStore(ctx.host.storage);
    registerBenchRoutes(ctx, store);
  },
});

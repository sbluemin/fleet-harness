import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handlePlansList, handlePlansRead } from "./server/handlers.js";

export default definePlugin({
  id: "plans",
  register(ctx) {
    registerRouter(ctx, "list", async ({ req, res }) => {
      await handlePlansList(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "read", async ({ req, res }) => {
      await handlePlansRead(req, res, ctx);
      return true;
    });
  },
});

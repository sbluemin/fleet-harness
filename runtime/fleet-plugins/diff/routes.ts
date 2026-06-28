import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleDiffChanged, handleDiffFile } from "./server/diff.js";

export default definePlugin({
  id: "diff",
  register(ctx) {
    registerRouter(ctx, "changed", async ({ req, res }) => {
      await handleDiffChanged(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "file", async ({ req, res }) => {
      await handleDiffFile(req, res, ctx);
      return true;
    });
  },
});

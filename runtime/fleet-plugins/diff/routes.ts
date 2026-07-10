import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleDiffCommit } from "./server/commit.js";
import { handleDiffChanged, handleDiffFile } from "./server/diff.js";
import { handleDiffLog } from "./server/log.js";

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
    registerRouter(ctx, "log", async ({ req, res }) => {
      await handleDiffLog(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "commit", async ({ req, res }) => {
      await handleDiffCommit(req, res, ctx);
      return true;
    });
  },
});

import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleFilesImage, handleFilesList, handleFilesRead } from "./server/handlers.js";

export default definePlugin({
  id: "file-explorer",
  register(ctx) {
    registerRouter(ctx, "files/list", async ({ req, res }) => {
      await handleFilesList(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "files/read", async ({ req, res }) => {
      await handleFilesRead(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "files/image", async ({ req, res }) => {
      await handleFilesImage(req, res, ctx);
      return true;
    });
  },
});

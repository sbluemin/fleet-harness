import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import {
  handleFilesClipboard,
  handleFilesImage,
  handleFilesList,
  handleFilesRead,
  handleFilesReveal,
  handleFilesWatch,
} from "./server/handlers.js";
import { handleFilesSearch } from "./server/search.js";

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
    registerRouter(ctx, "files/clipboard", async ({ req, res }) => {
      await handleFilesClipboard(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "files/reveal", async ({ req, res }) => {
      await handleFilesReveal(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "files/watch", ({ req, res }) => {
      handleFilesWatch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "files/palette-search", async ({ req, res }) => {
      await handleFilesSearch(req, res, ctx);
      return true;
    });
  },
});

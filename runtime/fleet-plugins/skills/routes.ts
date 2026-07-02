import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import {
  handleGetJob,
  handleInstalledFile,
  handleInstall,
  handleList,
  handlePreview,
  handleRemove,
  handleSearch,
  handleUpdate,
} from "./server/handlers.js";

export default definePlugin({
  id: "skills",
  register(ctx) {
    registerRouter(ctx, "list", async ({ req, res }) => {
      await handleList(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "search", async ({ req, res }) => {
      await handleSearch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "install", async ({ req, res }) => {
      await handleInstall(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "update", async ({ req, res }) => {
      await handleUpdate(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "jobs", async ({ req, res }) => {
      await handleGetJob(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "remove", async ({ req, res }) => {
      await handleRemove(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "preview", async ({ req, res }) => {
      await handlePreview(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "installed-file", async ({ req, res }) => {
      await handleInstalledFile(req, res, ctx);
      return true;
    });
  },
});

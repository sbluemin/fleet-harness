import path from "node:path";

import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { createDefaultExecutor } from "./server/cli.js";
import {
  handleGetJob,
  handleInstalledFile,
  handleInstall,
  handleList,
  handlePaletteSearch,
  handlePreview,
  handleRemove,
  handleSearch,
  handleUpdate,
} from "./server/handlers.js";

export default definePlugin({
  id: "skills",
  register(ctx) {
    const cliHome = path.join(ctx.host.paths.pluginDataDir("skills"), "cli");
    const executor = createDefaultExecutor(cliHome);

    registerRouter(ctx, "list", async ({ req, res }) => {
      await handleList(req, res, ctx, executor);
      return true;
    });
    registerRouter(ctx, "palette-search", async ({ req, res }) => {
      await handlePaletteSearch(req, res, ctx, executor);
      return true;
    });
    registerRouter(ctx, "search", async ({ req, res }) => {
      await handleSearch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "install", async ({ req, res }) => {
      await handleInstall(req, res, ctx, executor);
      return true;
    });
    registerRouter(ctx, "update", async ({ req, res }) => {
      await handleUpdate(req, res, ctx, executor);
      return true;
    });
    registerRouter(ctx, "jobs", async ({ req, res }) => {
      await handleGetJob(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "remove", async ({ req, res }) => {
      await handleRemove(req, res, ctx, executor);
      return true;
    });
    registerRouter(ctx, "preview", async ({ req, res }) => {
      await handlePreview(req, res, ctx, executor);
      return true;
    });
    registerRouter(ctx, "installed-file", async ({ req, res }) => {
      await handleInstalledFile(req, res, ctx, executor);
      return true;
    });
  },
});

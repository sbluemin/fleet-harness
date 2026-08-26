import path from "node:path";

import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { createDefaultExecutor } from "./server/cli.js";
import {
  handleGetJob,
  handleInstalledFile,
  handleInstalledPackage,
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
    }, { method: "GET", path: "", summary: "List installed skills.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "palette-search", async ({ req, res }) => {
      await handlePaletteSearch(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Search installed skills.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "search", async ({ req, res }) => {
      await handleSearch(req, res, ctx);
      return true;
    }, { method: "GET", path: "", summary: "Search the skill registry.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "install", async ({ req, res }) => {
      await handleInstall(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Install a skill.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "update", async ({ req, res }) => {
      await handleUpdate(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Update installed skills.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "jobs", async ({ req, res }) => {
      await handleGetJob(req, res, ctx);
      return true;
    }, { method: "GET", path: "", summary: "Read a skill job.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "remove", async ({ req, res }) => {
      await handleRemove(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Remove an installed skill.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "preview", async ({ req, res }) => {
      await handlePreview(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Preview a skill.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "installed-package", async ({ req, res }) => {
      await handleInstalledPackage(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Inspect an installed skill package.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "installed-file", async ({ req, res }) => {
      await handleInstalledFile(req, res, ctx, executor);
      return true;
    }, { method: "POST", path: "", summary: "Read an installed skill package file.", category: "Skills Plugin", gate: "origin-write", transport: "http" });
  },
});

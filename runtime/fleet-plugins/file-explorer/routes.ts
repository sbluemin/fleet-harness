import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import {
  handleFilesClipboard,
  handleFilesGitStatus,
  handleFilesImage,
  handleFilesList,
  handleFilesRead,
  handleFilesReveal,
  handleFilesWatch,
} from "./server/tree-services.js";
import { handleFilesSearch } from "./server/tree-services.js";

export default definePlugin({
  id: "file-explorer",
  register(ctx) {
    registerRouter(ctx, "files/list", async ({ req, res }) => {
      await handleFilesList(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "List files in a Theater.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "files/git-status", async ({ req, res }) => {
      await handleFilesGitStatus(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Read Git status for a Theater.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "files/read", async ({ req, res }) => {
      await handleFilesRead(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Read a file from a Theater.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "files/image", async ({ req, res }) => {
      await handleFilesImage(req, res, ctx);
      return true;
    }, { method: "GET", path: "", summary: "Read an image from a Theater.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "files/clipboard", async ({ req, res }) => {
      await handleFilesClipboard(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Copy a Theater path to the clipboard.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "files/reveal", async ({ req, res }) => {
      await handleFilesReveal(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Reveal a Theater path in the host.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "files/watch", ({ req, res }) => {
      handleFilesWatch(req, res, ctx);
      return true;
    }, { method: "GET", path: "", summary: "Stream Theater file changes.", category: "File Explorer Plugin", gate: "origin-write", transport: "sse" });
    registerRouter(ctx, "files/palette-search", async ({ req, res }) => {
      await handleFilesSearch(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Search files in a Theater.", category: "File Explorer Plugin", gate: "origin-write", transport: "http" });
  },
});

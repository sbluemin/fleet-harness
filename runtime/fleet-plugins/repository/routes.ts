import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleRepositoryCommit } from "./server/commit.js";
import { handleRepositoryCommitFile } from "./server/commit-file.js";
import { handleRepositoryCompare } from "./server/compare.js";
import { handleRepositoryCompareFile } from "./server/compare-file.js";
import { handleRepositoryChanged, handleRepositoryFile } from "./server/diff.js";
import { handleRepositoryFetch } from "./server/fetch.js";
import { handleRepositoryLog } from "./server/log.js";
import { handleRepositoryRefs } from "./server/refs.js";
import { handleRepositoryRepos } from "./server/repos.js";
import { handleRepositorySearch } from "./server/search.js";
import { handleRepositoryWorktrees } from "./server/worktrees.js";

export default definePlugin({
  id: "repository",
  register(ctx) {
    registerRouter(ctx, "repos", { method: "POST", path: "", summary: "List repositories in a Theater.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryRepos(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "worktrees", { method: "POST", path: "", summary: "List repository worktrees.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryWorktrees(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "changed", { method: "POST", path: "", summary: "List changed repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryChanged(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "fetch", { method: "POST", path: "", summary: "Fetch repository data.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryFetch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "file", { method: "POST", path: "", summary: "Read a repository file diff.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryFile(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "log", { method: "POST", path: "", summary: "Read repository history.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryLog(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "palette-search", { method: "POST", path: "", summary: "Search repository commits.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositorySearch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "refs", { method: "POST", path: "", summary: "Read repository refs.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => { await handleRepositoryRefs(req, res, ctx); return true; });
    registerRouter(ctx, "commit", { method: "POST", path: "", summary: "Read repository commit details.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryCommit(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "commit-file", { method: "POST", path: "", summary: "Read a file diff at a repository commit.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryCommitFile(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "compare", { method: "POST", path: "", summary: "Compare repository revisions.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryCompare(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "compare-file", { method: "POST", path: "", summary: "Compare repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" }, async ({ req, res }) => {
      await handleRepositoryCompareFile(req, res, ctx);
      return true;
    });
  },
});

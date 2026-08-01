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
    registerRouter(ctx, "repos", async ({ req, res }) => {
      await handleRepositoryRepos(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "worktrees", async ({ req, res }) => {
      await handleRepositoryWorktrees(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "changed", async ({ req, res }) => {
      await handleRepositoryChanged(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "fetch", async ({ req, res }) => {
      await handleRepositoryFetch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "file", async ({ req, res }) => {
      await handleRepositoryFile(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "log", async ({ req, res }) => {
      await handleRepositoryLog(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "palette-search", async ({ req, res }) => {
      await handleRepositorySearch(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "refs", async ({ req, res }) => { await handleRepositoryRefs(req, res, ctx); return true; });
    registerRouter(ctx, "commit", async ({ req, res }) => {
      await handleRepositoryCommit(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "commit-file", async ({ req, res }) => {
      await handleRepositoryCommitFile(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "compare", async ({ req, res }) => {
      await handleRepositoryCompare(req, res, ctx);
      return true;
    });
    registerRouter(ctx, "compare-file", async ({ req, res }) => {
      await handleRepositoryCompareFile(req, res, ctx);
      return true;
    });
  },
});

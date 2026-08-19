import { definePlugin, registerRouter } from "@fleet-console/sdk/plugin/node";

import { handleRepositoryCommit } from "./server/commit.js";
import { handleRepositoryCommitCreate } from "./server/commit-create.js";
import { handleRepositoryCommitFile } from "./server/commit-file.js";
import { handleRepositoryCompare } from "./server/compare.js";
import { handleRepositoryCompareFile } from "./server/compare-file.js";
import { handleRepositoryChanged, handleRepositoryFile } from "./server/diff.js";
import { handleRepositoryFetch } from "./server/fetch.js";
import { handleRepositoryLog } from "./server/log.js";
import { handleRepositoryPull, handleRepositoryPush } from "./server/remote.js";
import { handleRepositoryRefs } from "./server/refs.js";
import { handleRepositoryRepos } from "./server/repos.js";
import { handleRepositorySearch } from "./server/search.js";
import { handleRepositoryDiscard, handleRepositoryStage, handleRepositoryUnstage } from "./server/stage.js";
import { handleRepositoryStash } from "./server/stash.js";
import { handleRepositoryStatus } from "./server/status.js";
import { handleRepositoryTree } from "./server/tree.js";
import { handleRepositoryWorkstate } from "./server/workstate.js";
import { handleRepositoryWorktrees } from "./server/worktrees.js";

export default definePlugin({
  id: "repository",
  register(ctx) {
    registerRouter(ctx, "repos", async ({ req, res }) => {
      await handleRepositoryRepos(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "List repositories in a Theater.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "worktrees", async ({ req, res }) => {
      await handleRepositoryWorktrees(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "List repository worktrees.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "changed", async ({ req, res }) => {
      await handleRepositoryChanged(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "List changed repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "fetch", async ({ req, res }) => {
      await handleRepositoryFetch(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Fetch repository data.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "file", async ({ req, res }) => {
      await handleRepositoryFile(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Read a repository file diff.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "log", async ({ req, res }) => {
      await handleRepositoryLog(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Read repository history.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "palette-search", async ({ req, res }) => {
      await handleRepositorySearch(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Search repository commits.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "refs", async ({ req, res }) => { await handleRepositoryRefs(req, res, ctx); return true; }, { method: "POST", path: "", summary: "Read repository refs.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "commit", async ({ req, res }) => {
      await handleRepositoryCommit(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Read repository commit details.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "commit-file", async ({ req, res }) => {
      await handleRepositoryCommitFile(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Read a file diff at a repository commit.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "compare", async ({ req, res }) => {
      await handleRepositoryCompare(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Compare repository revisions.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "compare-file", async ({ req, res }) => {
      await handleRepositoryCompareFile(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Compare repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "tree", async ({ req, res }) => {
      await handleRepositoryTree(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "List one folder of a commit tree.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "workstate", async ({ req, res }) => {
      await handleRepositoryWorkstate(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Report write-safety state for a checkout.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "status", async ({ req, res }) => {
      await handleRepositoryStatus(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "List staged and unstaged repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "stage", async ({ req, res }) => {
      await handleRepositoryStage(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Stage repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "unstage", async ({ req, res }) => {
      await handleRepositoryUnstage(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Unstage repository files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "discard", async ({ req, res }) => {
      await handleRepositoryDiscard(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Discard working-tree changes for chosen files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "commit-create", async ({ req, res }) => {
      await handleRepositoryCommitCreate(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Create or amend a commit from the staged files.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "stash", async ({ req, res }) => {
      await handleRepositoryStash(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Save, apply, pop, or drop a stash.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "push", async ({ req, res }) => {
      await handleRepositoryPush(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Push the current branch to its upstream.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
    registerRouter(ctx, "pull", async ({ req, res }) => {
      await handleRepositoryPull(req, res, ctx);
      return true;
    }, { method: "POST", path: "", summary: "Fast-forward the current branch from its upstream.", category: "Repository Plugin", gate: "origin-write", transport: "http" });
  },
});

import type { ConsoleUseMcpHost } from "../../console-use/shared/tools.js";
import type { OwnedProcessPort } from "@fleet-console/process";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler } from "@fleet-console/infra/http/routing";

import { handleRepositoryCommit } from "./commit.js";
import { handleRepositoryCommitCreate } from "./commit-create.js";
import { handleRepositoryCommitFile } from "./commit-file.js";
import { handleRepositoryCompare } from "./compare.js";
import { handleRepositoryCompareFile } from "./compare-file.js";
import { handleRepositoryChanged, handleRepositoryFile } from "./diff.js";
import { handleRepositoryFetch } from "./fetch.js";
import { handleRepositoryLog } from "./log.js";
import { handleRepositoryPull, handleRepositoryPush } from "./remote.js";
import { handleRepositoryRefs } from "./refs.js";
import { handleRepositoryRepos } from "./repos.js";
import { handleRepositorySearch } from "./search.js";
import { handleRepositoryDiscard, handleRepositoryStage, handleRepositoryUnstage } from "./stage.js";
import { handleRepositoryStash } from "./stash.js";
import { handleRepositoryStatus } from "./status.js";
import { handleRepositoryTree } from "./tree.js";
import { handleRepositoryBlob } from "./blob.js";
import { handleRepositoryWorkstate } from "./workstate.js";
import { handleRepositoryWorktrees } from "./worktrees.js";
import { createRepositoryConsoleTools } from "./console-tools.js";

export interface RepositoryFeatureDeps { readonly paths: WorkspacePaths; readonly http: HttpPort; readonly security: HttpSecurityPort; readonly processes?: OwnedProcessPort;

  readonly consoleUse: ConsoleUseMcpHost;
}
export interface RepositoryRouteContext { readonly host: RepositoryFeatureDeps }
export function createRepositoryFeature(deps: RepositoryFeatureDeps) {
  const ctx = { host: deps };
  const routes: { path: string; handler: RouteHandler; catalog: readonly ApiCatalogEntry[] }[] = [];
  const addRoute = (name: string, handler: RouteHandler, catalog: ApiCatalogEntry) => {
    const path = `/api/v1/repository/${name}`;
    routes.push({ path, handler, catalog: [{ ...catalog, path: path + catalog.path }] });
  };
  // Console Use 에 저장소 읽기 도구를 싣는다 — 에이전트가 다른 Theater·worktree 의 상태·diff·로그를 보고 판단하도록.
  const releaseConsoleTools = ctx.host.consoleUse.contribute?.(createRepositoryConsoleTools(ctx));
  addRoute("repos", async ({ req, res }) => {
    await handleRepositoryRepos(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "List repositories in a Theater.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("worktrees", async ({ req, res }) => {
    await handleRepositoryWorktrees(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "List repository worktrees.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("changed", async ({ req, res }) => {
    await handleRepositoryChanged(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "List changed repository files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("fetch", async ({ req, res }) => {
    await handleRepositoryFetch(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Fetch repository data.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("file", async ({ req, res }) => {
    await handleRepositoryFile(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read a repository file diff.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("log", async ({ req, res }) => {
    await handleRepositoryLog(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read repository history.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("palette-search", async ({ req, res }) => {
    await handleRepositorySearch(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Search repository commits.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("refs", async ({ req, res }) => { await handleRepositoryRefs(req, res, ctx); return true; }, { method: "POST", path: "", summary: "Read repository refs.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("commit", async ({ req, res }) => {
    await handleRepositoryCommit(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read repository commit details.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("commit-file", async ({ req, res }) => {
    await handleRepositoryCommitFile(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read a file diff at a repository commit.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("compare", async ({ req, res }) => {
    await handleRepositoryCompare(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Compare repository revisions.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("compare-file", async ({ req, res }) => {
    await handleRepositoryCompareFile(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Compare repository files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("tree", async ({ req, res }) => {
    await handleRepositoryTree(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "List one folder of a commit tree.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("blob", async ({ req, res }) => {
    await handleRepositoryBlob(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read one file at a commit.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("workstate", async ({ req, res }) => {
    await handleRepositoryWorkstate(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Report write-safety state for a checkout.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("status", async ({ req, res }) => {
    await handleRepositoryStatus(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "List staged and unstaged repository files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("stage", async ({ req, res }) => {
    await handleRepositoryStage(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Stage repository files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("unstage", async ({ req, res }) => {
    await handleRepositoryUnstage(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Unstage repository files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("discard", async ({ req, res }) => {
    await handleRepositoryDiscard(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Discard working-tree changes for chosen files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("commit-create", async ({ req, res }) => {
    await handleRepositoryCommitCreate(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Create or amend a commit from the staged files.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("stash", async ({ req, res }) => {
    await handleRepositoryStash(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Save, apply, pop, drop, or show a stash.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("push", async ({ req, res }) => {
    await handleRepositoryPush(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Push the current branch to its upstream.", category: "Repository", gate: "origin-write", transport: "http" });
  addRoute("pull", async ({ req, res }) => {
    await handleRepositoryPull(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Fast-forward the current branch from its upstream.", category: "Repository", gate: "origin-write", transport: "http" });
  return { routes, dispose: () => releaseConsoleTools?.() };
}

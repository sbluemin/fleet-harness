import type { ConsoleUseMcpHost } from "../../console-use/shared/tools.js";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import type { ApiCatalogEntry } from "@fleet-console/infra/http/catalog";
import type { RouteHandler } from "@fleet-console/infra/http/routing";

import {
  handleFilesClipboard,
  handleFilesDiskStatus,
  handleFilesGitStatus,
  handleFilesImage,
  handleFilesList,
  handleFilesRead,
  handleFilesResolve,
  handleFilesReveal,
  handleFilesWatch,
} from "./tree-services.js";
import { handleFilesSearch } from "./tree-services.js";
import { createFileExplorerConsoleTools } from "./console-tools.js";

export interface FileExplorerFeatureDeps { readonly paths: WorkspacePaths; readonly http: HttpPort; readonly security: HttpSecurityPort;

  readonly consoleUse: ConsoleUseMcpHost;
}
export interface FileExplorerRouteContext { readonly host: FileExplorerFeatureDeps }
export function createFileExplorerFeature(deps: FileExplorerFeatureDeps) {
  const ctx = { host: deps };
  const routes: { path: string; handler: RouteHandler; catalog: readonly ApiCatalogEntry[] }[] = [];
  const addRoute = (name: string, handler: RouteHandler, catalog: ApiCatalogEntry) => {
    const path = `/api/v1/file-explorer/${name}`;
    routes.push({ path, handler, catalog: [{ ...catalog, path: path + catalog.path }] });
  };
  // Console Use 에 파일 읽기 도구를 싣는다 — 탐색기와 같은 경로 봉쇄·숨김 규칙으로, 쓰기는 없이.
  const releaseConsoleTools = ctx.host.consoleUse.contribute?.(createFileExplorerConsoleTools(ctx));
  addRoute("files/list", async ({ req, res }) => {
    await handleFilesList(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "List files in a Theater.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/git-status", async ({ req, res }) => {
    await handleFilesGitStatus(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read Git status for a Theater.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/resolve", async ({ req, res }) => {
    await handleFilesResolve(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Resolve a file reference within a Theater.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/disk-status", async ({ req, res }) => {
    await handleFilesDiskStatus(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Check open files for disk changes without reading their contents.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/read", async ({ req, res }) => {
    await handleFilesRead(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Read a file from a Theater.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/image", async ({ req, res }) => {
    await handleFilesImage(req, res, ctx);
    return true;
  }, { method: "GET", path: "", summary: "Read an image from a Theater.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/clipboard", async ({ req, res }) => {
    await handleFilesClipboard(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Copy a Theater path to the clipboard.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/reveal", async ({ req, res }) => {
    await handleFilesReveal(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Reveal a Theater path in the host.", category: "File Explorer", gate: "origin-write", transport: "http" });
  addRoute("files/watch", ({ req, res }) => {
    handleFilesWatch(req, res, ctx);
    return true;
  }, { method: "GET", path: "", summary: "Stream Theater file changes.", category: "File Explorer", gate: "origin-write", transport: "sse" });
  addRoute("files/palette-search", async ({ req, res }) => {
    await handleFilesSearch(req, res, ctx);
    return true;
  }, { method: "POST", path: "", summary: "Search files in a Theater.", category: "File Explorer", gate: "origin-write", transport: "http" });
  return { routes, dispose: () => releaseConsoleTools?.() };
}

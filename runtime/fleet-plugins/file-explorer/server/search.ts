import fs from "node:fs/promises";
import path from "node:path";
import type http from "node:http";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { FileSearchItem } from "./types.js";

const SEARCH_DIRECTORY_CAP = 500;
const SEARCH_ENTRY_CAP = 25_000;

export async function searchTheaterFiles(theaterPath: string, query: string, limit: number): Promise<FileSearchItem[]> {
  const realRoot = await fs.realpath(theaterPath);
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const pending: Array<{ readonly absolutePath: string; readonly relativePath: string }> = [{ absolutePath: realRoot, relativePath: "" }];
  const visited = new Set<string>();
  const matches: FileSearchItem[] = [];
  let directoryCount = 0;
  let entryCount = 0;

  while (pending.length > 0 && directoryCount < SEARCH_DIRECTORY_CAP && entryCount < SEARCH_ENTRY_CAP) {
    const directory = pending.shift();
    if (!directory || visited.has(directory.absolutePath)) continue;
    visited.add(directory.absolutePath);
    directoryCount += 1;

    let entries;
    try {
      entries = await fs.readdir(directory.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entryCount >= SEARCH_ENTRY_CAP) break;
      entryCount += 1;
      const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory.absolutePath, entry.name);
      let kind: "dir" | "file" | null = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
      let realPath = absolutePath;
      if (entry.isSymbolicLink()) {
        try {
          realPath = await fs.realpath(absolutePath);
          if (!isContained(realRoot, realPath)) continue;
          const stat = await fs.stat(realPath);
          kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
        } catch {
          continue;
        }
      }
      if (kind === "dir") {
        if (!visited.has(realPath)) pending.push({ absolutePath: realPath, relativePath });
        continue;
      }
      if (kind !== "file") continue;
      const low = relativePath.toLocaleLowerCase();
      if (tokens.every((token) => low.includes(token))) matches.push({ relativePath });
    }
  }

  return matches
    .sort((left, right) => compareFileSearchItem(left, right, query))
    .slice(0, limit);
}

export async function handleFilesSearch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: FleetPluginServerContext,
): Promise<void> {
  if (req.method !== "POST") { ctx.host.http.writeJson(res, 405, { error: "Method not allowed" }); return; }
  if (!ctx.host.security.isTerminalAuthorized(req)) { ctx.host.http.writeJson(res, 401, { error: "unauthorized" }); return; }
  const body = await ctx.host.http.readJsonBody<{
    readonly theaterId?: unknown;
    readonly query?: unknown;
    readonly limit?: unknown;
  }>(req);
  if (
    !isPlainObject(body)
    || typeof body.theaterId !== "string"
    || typeof body.query !== "string"
    || body.query.trim() === ""
    || !Number.isInteger(body.limit)
    || (body.limit as number) < 1
    || (body.limit as number) > 8
  ) {
    ctx.host.http.writeJson(res, 400, { error: "invalid_request" });
    return;
  }
  const theaterPath = ctx.host.paths.resolveTheaterPath(body.theaterId);
  if (!theaterPath) { ctx.host.http.writeJson(res, 404, { error: "theater_not_found" }); return; }
  try {
    ctx.host.http.writeJson(res, 200, {
      files: await searchTheaterFiles(theaterPath, body.query, body.limit as number),
    });
  } catch {
    ctx.host.http.writeJson(res, 500, { error: "search_failed" });
  }
}

function compareFileSearchItem(left: FileSearchItem, right: FileSearchItem, query: string): number {
  const lowQuery = query.trim().toLocaleLowerCase();
  const leftName = left.relativePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const rightName = right.relativePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const leftRank = leftName === lowQuery ? 0 : leftName.startsWith(lowQuery) ? 1 : 2;
  const rightRank = rightName === lowQuery ? 0 : rightName.startsWith(lowQuery) ? 1 : 2;
  return leftRank - rightRank || left.relativePath.localeCompare(right.relativePath);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

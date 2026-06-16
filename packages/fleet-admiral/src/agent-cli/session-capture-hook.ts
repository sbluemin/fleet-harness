import process from "node:process";
import { pathToFileURL } from "node:url";

import type { FleetHookExec } from "./types.js";

export function createSessionCaptureHookExec(deps: {
  readonly entryPath: string;
  readonly execPath?: string;
  readonly provider: string;
  readonly tsxLoader?: string;
}): FleetHookExec {
  const args = deps.tsxLoader
    ? [
        "--import",
        pathToFileURL(deps.tsxLoader).href,
        deps.entryPath,
        "hook",
        "capture-session",
        deps.provider,
      ]
    : [deps.entryPath, "hook", "capture-session", deps.provider];
  return {
    command: deps.execPath ?? process.execPath,
    args,
  };
}

import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipboardUnavailableError, copyPathToClipboard } from "../server/path-actions.js";
import { handleFilesClipboard, handleFilesReveal } from "../server/tree-services.js";
import { PathActionError } from "../server/path-actions.js";
import { revealPath, resolveRevealCommand } from "../server/path-actions.js";

interface JsonWrite {
  readonly status: number;
  readonly payload: unknown;
}

let temporaryDirectory: string;
let theaterPath: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fexp-actions-"));
  theaterPath = path.join(temporaryDirectory, "theater");
  await fs.mkdir(path.join(theaterPath, "src"), { recursive: true });
  await fs.writeFile(path.join(theaterPath, "src", "file.ts"), "export {};");
  await fs.symlink(path.join(theaterPath, "src", "file.ts"), path.join(theaterPath, "file-link.ts"));
  await fs.writeFile(path.join(temporaryDirectory, "outside.txt"), "secret");
  await fs.symlink(path.join(temporaryDirectory, "outside.txt"), path.join(theaterPath, "escape.txt"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("file action routes", () => {

  it("keeps terminal authorization ahead of every file action", async () => {
    const writes: JsonWrite[] = [];
    const copyPath = vi.fn(async () => undefined);
    await handleFilesClipboard(
      { method: "POST" } as http.IncomingMessage,
      makeResponse().value,
      makeContext({ theaterId: "theater-a", relativePath: "src/file.ts" }, writes, false),
      { copyPath },
    );

    expect(copyPath).not.toHaveBeenCalled();
    expect(writes).toEqual([{ status: 401, payload: { error: "unauthorized" } }]);
  });
});

describe("clipboard process arguments and containment", () => {

  it("rejects even an in-Theater absolute path from the browser DTO", async () => {
    const runWithInput = vi.fn(async () => undefined);
    await expect(copyPathToClipboard(theaterPath, path.join(theaterPath, "src", "file.ts"), {
      platform: "darwin",
      runWithInput,
    })).rejects.toSatisfy(
      (error: unknown) => error instanceof PathActionError && error.code === "path_outside_theater",
    );
    expect(runWithInput).not.toHaveBeenCalled();
  });
});

describe("reveal process arguments and containment", () => {
  it("builds the host-fixed process arguments for every supported platform", () => {
    const absolutePath = path.join(theaterPath, "src", "file.ts");
    expect(resolveRevealCommand("darwin", "reveal", absolutePath)).toEqual({ file: "open", args: ["-R", absolutePath] });
    expect(resolveRevealCommand("darwin", "open", absolutePath)).toEqual({ file: "open", args: [absolutePath] });
    expect(resolveRevealCommand("linux", "reveal", absolutePath)).toEqual({ file: "xdg-open", args: [path.dirname(absolutePath)] });
    expect(resolveRevealCommand("linux", "open", absolutePath)).toEqual({ file: "xdg-open", args: [absolutePath] });
    expect(resolveRevealCommand("win32", "reveal", absolutePath)).toEqual({ file: "explorer", args: [`/select,${absolutePath}`] });
    expect(resolveRevealCommand("win32", "open", absolutePath)).toEqual({ file: "explorer", args: [absolutePath] });
  });

  it("launches with the contained real path rather than the logical symlink path", async () => {
    const launch = vi.fn(async () => undefined);
    await revealPath(theaterPath, "file-link.ts", "reveal", { platform: "darwin", launch });
    expect(launch).toHaveBeenCalledWith("open", ["-R", await fs.realpath(path.join(theaterPath, "file-link.ts"))]);
  });
});

function makeContext(
  body: Record<string, unknown>,
  writes: JsonWrite[],
  authorized = true,
): FleetPluginServerContext {
  return {
    host: {
      http: {
        readJsonBody: async () => body,
        writeJson: (_res: http.ServerResponse, status: number, payload: unknown) => writes.push({ status, payload }),
      },
      security: { isTerminalAuthorized: () => authorized },
      paths: { resolveTheaterPath: () => theaterPath },
    },
  } as unknown as FleetPluginServerContext;
}

function makeResponse(): { readonly value: http.ServerResponse; readonly end: ReturnType<typeof vi.fn> } {
  const end = vi.fn();
  return { value: { statusCode: 200, end } as unknown as http.ServerResponse, end };
}

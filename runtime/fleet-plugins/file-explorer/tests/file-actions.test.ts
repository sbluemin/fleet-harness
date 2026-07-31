import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipboardUnavailableError, copyPathToClipboard } from "../server/clipboard.js";
import { handleFilesClipboard, handleFilesReveal } from "../server/handlers.js";
import { PathActionError } from "../server/path-actions.js";
import { revealPath, resolveRevealCommand } from "../server/reveal.js";

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
  await fs.writeFile(path.join(temporaryDirectory, "outside.txt"), "secret");
  await fs.symlink(path.join(temporaryDirectory, "outside.txt"), path.join(theaterPath, "escape.txt"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("file action routes", () => {
  it("passes the resolved Theater path and relative path to clipboard and returns an empty 204", async () => {
    const writes: JsonWrite[] = [];
    const copyPath = vi.fn(async () => undefined);
    const response = makeResponse();

    await handleFilesClipboard(
      { method: "POST" } as http.IncomingMessage,
      response.value,
      makeContext({ theaterId: "theater-a", relativePath: "src/file.ts" }, writes),
      { copyPath },
    );

    expect(copyPath).toHaveBeenCalledWith(theaterPath, "src/file.ts");
    expect(response.value.statusCode).toBe(204);
    expect(response.end).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it("passes the fixed reveal mode and returns an empty 204", async () => {
    const writes: JsonWrite[] = [];
    const invokeReveal = vi.fn(async () => undefined);
    const response = makeResponse();

    await handleFilesReveal(
      { method: "POST" } as http.IncomingMessage,
      response.value,
      makeContext({ theaterId: "theater-a", relativePath: "src/file.ts", mode: "reveal" }, writes),
      { revealPath: invokeReveal },
    );

    expect(invokeReveal).toHaveBeenCalledWith(theaterPath, "src/file.ts", "reveal");
    expect(response.value.statusCode).toBe(204);
    expect(response.end).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it("maps missing clipboard tools to the fixed 501 payload", async () => {
    const writes: JsonWrite[] = [];
    await handleFilesClipboard(
      { method: "POST" } as http.IncomingMessage,
      makeResponse().value,
      makeContext({ theaterId: "theater-a", relativePath: "src/file.ts" }, writes),
      { copyPath: async () => { throw new ClipboardUnavailableError(); } },
    );

    expect(writes).toEqual([{ status: 501, payload: { error: "clipboard_unavailable" } }]);
  });

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
  it("pipes only the contained absolute path to pbcopy without shell arguments", async () => {
    const runWithInput = vi.fn(async () => undefined);
    await copyPathToClipboard(theaterPath, "src/file.ts", { platform: "darwin", runWithInput });

    expect(runWithInput).toHaveBeenCalledWith("pbcopy", [], path.join(theaterPath, "src", "file.ts"));
  });

  it("detects Linux clipboard tools in wl-copy, xclip, xsel order", async () => {
    const probes: string[] = [];
    const runWithInput = vi.fn(async () => undefined);
    await copyPathToClipboard(theaterPath, "src/file.ts", {
      platform: "linux",
      findExecutable: async (name) => {
        probes.push(name);
        return name === "xclip" ? "/usr/bin/xclip" : null;
      },
      runWithInput,
    });

    expect(probes).toEqual(["wl-copy", "xclip"]);
    expect(runWithInput).toHaveBeenCalledWith(
      "/usr/bin/xclip",
      ["-selection", "clipboard"],
      path.join(theaterPath, "src", "file.ts"),
    );
  });

  it.each(["../outside.txt", "escape.txt"])("rejects escaping clipboard path %s before execution", async (relativePath) => {
    const runWithInput = vi.fn(async () => undefined);
    await expect(copyPathToClipboard(theaterPath, relativePath, {
      platform: "darwin",
      runWithInput,
    })).rejects.toSatisfy(
      (error: unknown) => error instanceof PathActionError && error.code === "path_outside_theater",
    );
    expect(runWithInput).not.toHaveBeenCalled();
  });

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

  it("launches only after resolving a contained real path", async () => {
    const launch = vi.fn(async () => undefined);
    await revealPath(theaterPath, "src/file.ts", "reveal", { platform: "darwin", launch });
    expect(launch).toHaveBeenCalledWith("open", ["-R", path.join(theaterPath, "src", "file.ts")]);
  });

  it.each(["../outside.txt", "escape.txt"])("rejects escaping reveal path %s before spawn", async (relativePath) => {
    const launch = vi.fn(async () => undefined);
    await expect(revealPath(theaterPath, relativePath, "open", {
      platform: "darwin",
      launch,
    })).rejects.toSatisfy(
      (error: unknown) => error instanceof PathActionError && error.code === "path_outside_theater",
    );
    expect(launch).not.toHaveBeenCalled();
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

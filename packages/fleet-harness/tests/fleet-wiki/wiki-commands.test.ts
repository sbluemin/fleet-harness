import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { approveAndNotify, listQueueItems, rejectAndNotify, runDrydock, runStatus, showPatchDetail } from "../../src/wiki/handlers.js";
import { registerWikiCommands } from "../../src/wiki/ui.js";
import { enqueuePatch, parsePatch } from "@sbluemin/fleet-wiki";
import { resolveMemoryPaths } from "@sbluemin/fleet-wiki";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("wiki commands", () => {
  it("registers only fleet:wiki:menu", () => {
    const registerCommand = vi.fn();
    registerWikiCommands({ registerCommand, sendUserMessage: vi.fn() } as any);

    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0]?.[0]).toBe("fleet:wiki:menu");
  });

  it("lists queue items and exposes patch detail through handlers", async () => {
    const root = await makeTempRoot();
    const patchId = await seedPatch(root, "alpha");

    const items = await listQueueItems(root);
    const detail = await showPatchDetail(patchId, root);

    expect(items).toEqual([{ id: patchId, summary: "pending" }]);
    expect(detail.meta.id).toBe(patchId);
    expect(detail.target).toBe("wiki/alpha.md");
    expect(detail.summary).toBe("alpha");
    expect(detail.body).toContain("\"body\":\"hello\"");
  });

  it("approves and rejects through handlers with notify side effects", async () => {
    const approvedRoot = await makeTempRoot();
    const rejectedRoot = await makeTempRoot();
    const approvedId = await seedPatch(approvedRoot, "beta");
    const rejectedId = await seedPatch(rejectedRoot, "gamma");
    const approveNotify = vi.fn();
    const rejectNotify = vi.fn();

    await approveAndNotify(approvedId, makeNotifyContext(approvedRoot, approveNotify));
    await rejectAndNotify(rejectedId, "nope", makeNotifyContext(rejectedRoot, rejectNotify));

    expect(approveNotify).toHaveBeenCalledWith(`Approved ${approvedId}`, "info");
    expect(rejectNotify).toHaveBeenCalledWith(`Rejected ${rejectedId}`, "info");
  });

  it("reports status and drydock results through handlers", async () => {
    const root = await makeTempRoot();
    const notify = vi.fn();

    await runStatus(makeNotifyContext(root, notify));
    await runDrydock(makeNotifyContext(root, notify));

    expect(notify).toHaveBeenNthCalledWith(1, "Fleet Wiki ready: 0 wiki entries", "info");
    expect(notify).toHaveBeenNthCalledWith(2, "Drydock: OK", "info");
  });
});

function makeNotifyContext(root: string, notify: ReturnType<typeof vi.fn>): any {
  return {
    cwd: root,
    ui: {
      notify,
    },
  };
}

async function seedPatch(root: string, id: string): Promise<string> {
  const paths = resolveMemoryPaths(root);
  const patch = await parsePatch(`---\nop: "create_wiki"\ntarget: "wiki/${id}.md"\nsummary: "${id}"\nproposer: "test"\ncreated: "2026-04-26T00:00:00.000Z"\n---\n{"id":"${id}","title":"${id}","tags":[],"created":"2026-04-26T00:00:00.000Z","updated":"2026-04-26T00:00:00.000Z","version":1,"body":"hello"}`);
  return enqueuePatch(patch, paths);
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-wiki-commands-"));
  cleanupPaths.push(root);
  return root;
}

import { describe, expect, it } from "vitest";

import {
  buildWorkspaceManifest,
  captureWorkspaceSnapshot,
  WORKSPACE_CHANGE_CLEARED_STATUS,
  WORKSPACE_CHANGE_LIMIT,
  type WorkspaceChangeScanner,
} from "../../src/jobs/workspace-manifest.js";

describe("workspace change manifest helpers", () => {
  it("builds a window-approximate manifest from changed end entries", () => {
    const manifest = buildWorkspaceManifest(
      [{ status: "M", path: "same.ts" }],
      [
        { status: "M", path: "same.ts" },
        { status: "A", path: "new.ts" },
      ],
    );

    expect(manifest).toEqual({
      changes: [{ status: "A", path: "new.ts" }],
      truncated: false,
    });
  });

  it("detects same-status entries when both snapshots carry different content hashes", () => {
    const manifest = buildWorkspaceManifest(
      [{ status: "M", path: "dirty.ts", contentHash: "before-hash" }],
      [{ status: "M", path: "dirty.ts", contentHash: "after-hash" }],
    );

    expect(manifest).toBeDefined();
    expect(manifest!.changes).toEqual([{ status: "M", path: "dirty.ts" }]);
  });

  it("falls back to status-only comparison when hashes are absent", () => {
    const manifest = buildWorkspaceManifest(
      [{ status: "M", path: "dirty.ts", contentHash: "before-hash" }],
      [{ status: "M", path: "dirty.ts" }],
    );

    expect(manifest).toBeDefined();
    expect(manifest!.changes).toEqual([]);
  });

  it("returns undefined for null baseline or end snapshots", () => {
    expect(buildWorkspaceManifest(null, [])).toBeUndefined();
    expect(buildWorkspaceManifest([], null)).toBeUndefined();
    expect(buildWorkspaceManifest(null, null)).toBeUndefined();
  });

  it("caps changes at the configured limit and marks truncation", () => {
    const end = Array.from({ length: WORKSPACE_CHANGE_LIMIT + 2 }, (_, index) => ({
      status: "M",
      path: `file-${index}.ts`,
    }));

    const manifest = buildWorkspaceManifest([], end);

    expect(manifest).toBeDefined();
    expect(manifest!.changes).toHaveLength(WORKSPACE_CHANGE_LIMIT);
    expect(manifest!.truncated).toBe(true);
  });

  it("baseline에서 dirty였다가 종료 스냅샷에서 사라진 경로를 cleared로 방출", () => {
    const manifest = buildWorkspaceManifest(
      [
        { status: "M", path: "reverted.ts" },
        { status: "??", path: "removed.txt" },
        { status: "M", path: "kept.ts" },
      ],
      [{ status: "M", path: "kept.ts" }],
    );

    expect(manifest).toBeDefined();
    expect(manifest!.changes).toEqual([
      { status: WORKSPACE_CHANGE_CLEARED_STATUS, path: "reverted.ts" },
      { status: WORKSPACE_CHANGE_CLEARED_STATUS, path: "removed.txt" },
    ]);
  });

  it("preserves flattened rename paths", () => {
    const manifest = buildWorkspaceManifest([], [
      { status: "R", path: "old.ts -> new.ts" },
    ]);

    expect(manifest).toBeDefined();
    expect(manifest!.changes).toEqual([{ status: "R", path: "old.ts -> new.ts" }]);
  });

  it("wraps scanner failures as null snapshots", async () => {
    const scanner: WorkspaceChangeScanner = {
      async snapshot() {
        throw new Error("boom");
      },
    };

    await expect(captureWorkspaceSnapshot(scanner, "/tmp")).resolves.toBeNull();
    await expect(captureWorkspaceSnapshot(undefined, "/tmp")).resolves.toBeNull();
  });
});

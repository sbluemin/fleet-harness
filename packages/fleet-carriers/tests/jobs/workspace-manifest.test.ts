import { describe, expect, it } from "vitest";

import {
  buildWorkspaceManifest,
  captureWorkspaceSnapshot,
  unavailableWorkspaceManifest,
  WORKSPACE_CHANGE_ATTRIBUTION,
  WORKSPACE_CHANGE_CLEARED_STATUS,
  WORKSPACE_CHANGE_LIMIT,
  type WorkspaceChangeScanner,
} from "../../src/jobs/workspace-manifest.js";

describe("workspace change manifest helpers", () => {
  it("builds an available window-approximate manifest from changed end entries", () => {
    const manifest = buildWorkspaceManifest(
      [{ status: "M", path: "same.ts" }],
      [
        { status: "M", path: "same.ts" },
        { status: "A", path: "new.ts" },
      ],
    );

    expect(manifest).toEqual({
      attribution: WORKSPACE_CHANGE_ATTRIBUTION,
      available: true,
      changes: [{ status: "A", path: "new.ts" }],
      statLine: "1 file (window-approx)",
      truncated: false,
    });
  });

  it("returns unavailable manifests for null baseline or end snapshots", () => {
    expect(buildWorkspaceManifest(null, [])).toMatchObject({
      attribution: WORKSPACE_CHANGE_ATTRIBUTION,
      available: false,
      reason: "snapshot-unavailable",
      statLine: "unavailable",
      truncated: false,
    });
    expect(buildWorkspaceManifest([], null, "git-unavailable")).toMatchObject({
      available: false,
      reason: "git-unavailable",
    });
  });

  it("returns scanner-not-configured when no scanner is provided", () => {
    expect(unavailableWorkspaceManifest("scanner-not-configured")).toMatchObject({
      available: false,
      reason: "scanner-not-configured",
      changes: [],
    });
  });

  it("caps changes at the configured limit and marks truncation", () => {
    const end = Array.from({ length: WORKSPACE_CHANGE_LIMIT + 2 }, (_, index) => ({
      status: "M",
      path: `file-${index}.ts`,
    }));

    const manifest = buildWorkspaceManifest([], end);

    expect(manifest.changes).toHaveLength(WORKSPACE_CHANGE_LIMIT);
    expect(manifest.truncated).toBe(true);
    expect(manifest.statLine).toBe(`${WORKSPACE_CHANGE_LIMIT}+ files (window-approx)`);
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

    expect(manifest.changes).toEqual([
      { status: WORKSPACE_CHANGE_CLEARED_STATUS, path: "reverted.ts" },
      { status: WORKSPACE_CHANGE_CLEARED_STATUS, path: "removed.txt" },
    ]);
    expect(manifest.statLine).toBe("2 files (window-approx)");
  });

  it("preserves flattened rename paths", () => {
    const manifest = buildWorkspaceManifest([], [
      { status: "R", path: "old.ts -> new.ts" },
    ]);

    expect(manifest.changes).toEqual([{ status: "R", path: "old.ts -> new.ts" }]);
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

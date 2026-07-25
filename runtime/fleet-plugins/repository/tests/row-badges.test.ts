import { describe, expect, it, vi } from "vitest";

import {
  createRepositoryRowBadgeProvider,
  parsePorcelainV2Status,
  statusBadges,
} from "../server/row-badges.js";

describe("repository Theater row badges", () => {
  it("shows a seven-character OID for detached HEAD", () => {
    const status = parsePorcelainV2Status([
      "# branch.oid 1234567890abcdef",
      "# branch.head (detached)",
      "",
    ].join("\0"));

    expect(statusBadges(status)).toEqual([
      { id: "branch", text: "1234567", tone: "neutral" },
      { id: "changed", text: "clean", tone: "positive" },
    ]);
  });

  it("omits ahead and behind without an upstream and emits them when upstream exists", () => {
    const withoutUpstream = parsePorcelainV2Status([
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.ab +3 -2",
      "",
    ].join("\0"));
    const withUpstream = parsePorcelainV2Status([
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +3 -2",
      "",
    ].join("\0"));

    expect(statusBadges(withoutUpstream).map((badge) => badge.text)).toEqual(["main", "clean"]);
    expect(statusBadges(withUpstream)).toEqual([
      { id: "branch", text: "main", tone: "neutral" },
      { id: "changed", text: "clean", tone: "positive" },
      { id: "ahead", text: "↑3", tone: "info" },
      { id: "behind", text: "↓2", tone: "info" },
    ]);
  });

  it("counts tracked, unmerged, renamed, and untracked files once", () => {
    const status = parsePorcelainV2Status([
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 a b file-one",
      "u UU N... 100644 100644 100644 100644 a b c conflict",
      "2 R. N... 100644 100644 100644 a b R100 renamed",
      "? old-name-that-looks-like-a-record",
      "? untracked",
      "",
    ].join("\0"));

    expect(status.changed).toBe(4);
    expect(statusBadges(status)[1]).toEqual({ id: "changed", text: "4 changed", tone: "warn" });
  });

  it("reports truncated changed counts as a lower bound and never clean", () => {
    const changed = parsePorcelainV2Status([
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "? first",
      "? second",
      "",
    ].join("\0"), true);
    const noVisibleChanges = parsePorcelainV2Status([
      "# branch.oid 1234567890abcdef",
      "# branch.head main",
      "",
    ].join("\0"), true);

    expect(statusBadges(changed)[1]).toEqual({ id: "changed", text: "2+ changed", tone: "warn" });
    expect(statusBadges(noVisibleChanges)[1]).toEqual({ id: "changed", text: "0+ changed", tone: "warn" });
  });

  it("preserves completed Theater badges when another Theater fails or is aborted", async () => {
    const controller = new AbortController();
    const executeGit = vi.fn((
      _args: readonly string[],
      options: { readonly cwd: string; readonly signal?: AbortSignal },
    ) => {
      if (options.cwd === "/repo/fast") {
        return Promise.resolve({
          stdout: "# branch.oid 1234567890abcdef\0# branch.head main\0",
          truncated: false,
        });
      }
      if (options.cwd === "/repo/failed") return Promise.reject(new Error("git failed"));
      return new Promise<never>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const provider = createRepositoryRowBadgeProvider(
      (theaterId) => `/repo/${theaterId}`,
      executeGit,
    );
    const resultPromise = provider({
      theaterIds: ["fast", "slow", "failed"],
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(resultPromise).resolves.toEqual([{
      theaterId: "fast",
      badges: [
        { id: "branch", text: "main", tone: "neutral" },
        { id: "changed", text: "clean", tone: "positive" },
      ],
    }]);
  });

  it("runs one fixed-argument git process for each known Theater root", async () => {
    const executeGit = vi.fn(async (
      _args: readonly string[],
      _options: { readonly cwd: string; readonly signal?: AbortSignal },
    ) => ({
      stdout: "# branch.oid 1234567890abcdef\0# branch.head main\0",
      truncated: false,
    }));
    const provider = createRepositoryRowBadgeProvider(
      (theaterId) => theaterId === "missing" ? null : `/repo/${theaterId}`,
      executeGit,
    );
    const result = await provider({
      theaterIds: ["one", "two", "missing"],
      signal: new AbortController().signal,
    });

    expect(executeGit).toHaveBeenCalledTimes(2);
    expect(executeGit.mock.calls.map(([args, options]) => ({ args, cwd: options.cwd }))).toEqual([
      {
        args: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        cwd: "/repo/one",
      },
      {
        args: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        cwd: "/repo/two",
      },
    ]);
    expect(result.map((contribution) => contribution.theaterId)).toEqual(["one", "two"]);
  });
});

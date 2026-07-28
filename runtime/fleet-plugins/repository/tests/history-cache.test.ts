import { afterEach, describe, expect, it } from "vitest";

import { dropHistoryCache, dropHistoryCacheForRepository, HISTORY_CACHE_LIMIT, readHistoryCache, writeHistoryCache, type HistoryCacheEntry } from "../client/history-cache.js";
import type { LogCommitEntry } from "../server/types.js";

const scopes = new Set<string>();
const entry = (filterText: string): HistoryCacheEntry => ({
  commits: [],
  checkouts: [],
  hasMore: true,
  truncated: false,
  scrollTop: 120,
  targetHash: null,
  filterText,
});
const scope = (name: string): string => {
  scopes.add(name);
  return name;
};

afterEach(() => {
  for (const name of scopes) dropHistoryCache(name);
  scopes.clear();
});

describe("history cache", () => {
  it("reads back a written entry", () => {
    const key = scope("round-trip");
    const value = entry("author");

    writeHistoryCache(key, value);

    expect(readHistoryCache(key)).toBe(value);
  });

  it("evicts the least recently used key above HISTORY_CACHE_LIMIT", () => {
    const keys = Array.from({ length: HISTORY_CACHE_LIMIT + 1 }, (_, index) => scope(`limit-${index}`));
    keys.forEach((key, index) => writeHistoryCache(key, entry(String(index))));

    expect(readHistoryCache(keys[0]!)).toBeNull();
    expect(readHistoryCache(keys.at(-1)!)).not.toBeNull();
  });

  it("moves an updated key to the most recently used position", () => {
    const keys = Array.from({ length: HISTORY_CACHE_LIMIT }, (_, index) => scope(`update-${index}`));
    keys.forEach((key, index) => writeHistoryCache(key, entry(String(index))));
    const updated = entry("updated");

    writeHistoryCache(keys[0]!, updated);
    const overflow = scope("update-overflow");
    writeHistoryCache(overflow, entry("overflow"));

    expect(readHistoryCache(keys[0]!)).toBe(updated);
    expect(readHistoryCache(keys[1]!)).toBeNull();
  });

  it("moves a read key to the most recently used position", () => {
    const keys = Array.from({ length: HISTORY_CACHE_LIMIT }, (_, index) => scope(`read-${index}`));
    keys.forEach((key, index) => writeHistoryCache(key, entry(String(index))));

    expect(readHistoryCache(keys[0]!)).not.toBeNull();
    const overflow = scope("read-overflow");
    writeHistoryCache(overflow, entry("overflow"));

    expect(readHistoryCache(keys[0]!)).not.toBeNull();
    expect(readHistoryCache(keys[1]!)).toBeNull();
  });

  it("drops only the requested key", () => {
    const dropped = scope("drop-this");
    const retained = scope("keep-this");
    writeHistoryCache(dropped, entry("drop"));
    writeHistoryCache(retained, entry("keep"));

    dropHistoryCache(dropped);

    expect(readHistoryCache(dropped)).toBeNull();
    expect(readHistoryCache(retained)?.filterText).toBe("keep");
  });

  it("drops every ref entry for one repository and retains other repositories", () => {
    const repository = "theater:repo";
    const head = scope(`${repository}::`);
    const branch = scope(`${repository}::refs/heads/topic`);
    const other = scope("theater:other::refs/heads/topic");
    writeHistoryCache(head, entry("head"));
    writeHistoryCache(branch, entry("branch"));
    writeHistoryCache(other, entry("other"));

    dropHistoryCacheForRepository(repository);

    expect(readHistoryCache(head)).toBeNull();
    expect(readHistoryCache(branch)).toBeNull();
    expect(readHistoryCache(other)?.filterText).toBe("other");
  });

  it("round-trips an entry containing commit data without loss", () => {
    const commit: LogCommitEntry = {
      shortHash: "abc1234",
      fullHash: "abc1234def5678abc1234def5678abc1234def56",
      subject: "Preserve cached history",
      authorName: "Fleet",
      relTime: "1 minute ago",
      authorAt: 1_700_000_000,
      refs: ["HEAD -> canary"],
      parents: ["parent"],
      onHead: true,
    };
    const key = scope("commit-round-trip");
    const value: HistoryCacheEntry = {
      ...entry("Fleet"),
      commits: [commit],
      checkouts: [{ sha: commit.fullHash, branch: "canary", isCurrent: true }],
      targetHash: commit.fullHash,
    };

    writeHistoryCache(key, value);

    expect(readHistoryCache(key)).toEqual(value);
  });
});

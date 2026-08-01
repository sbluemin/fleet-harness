import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

const railPanelSource = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
const historyPanelSource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");

describe("Repository sync client contracts", () => {
  it("keeps Sync button busy-state without a status strip", () => {
    expect(railPanelSource).toContain("const [syncing, setSyncing] = useState(false)");
    expect(railPanelSource).toContain("setSyncing(true)");
    expect(railPanelSource).toContain("setSyncing(false)");
    expect(railPanelSource).toContain("disabled={syncing}");
    expect(railPanelSource).toContain('repository-sync-button${syncing ? " is-syncing" : ""}');
    expect(railPanelSource).not.toContain("repository-sync-status");
    expect(railPanelSource).not.toContain("syncStatusMessage");
    expect(railPanelSource).not.toContain("formatSyncAge");
    expect(railPanelSource).not.toContain("repository.sync.status.");
  });

  it("refreshes local data on successful fetch and skips no-op throttle hits", () => {
    expect(railPanelSource).toContain('if ("skipped" in payload) return');
    expect(railPanelSource).toContain("refreshRepositoryData()");
  });

  it("refreshes all local data bumpers while keeping History mounted", () => {
    const refreshStart = railPanelSource.indexOf("const refreshRepositoryData");
    const refreshEnd = railPanelSource.indexOf("const syncRepository", refreshStart);
    const refreshSource = railPanelSource.slice(refreshStart, refreshEnd);
    expect(refreshSource).toContain("setRefsRetry");
    expect(refreshSource).toContain("setWorktreesRetry");
    expect(refreshSource).toContain("setChangedFilesRetry");
    expect(refreshSource).toContain("setReposRetry");
    expect(refreshSource).toContain("setHistoryExternalRefreshToken");
    expect(refreshSource).not.toContain("setHistoryLandingEpoch");
    expect(railPanelSource).toContain("externalRefreshToken={historyExternalRefreshToken}");
  });

  it("captures external-refresh scroll before loading and restores it with the new rows", () => {
    const refreshStart = historyPanelSource.indexOf("const externalRefreshRequested");
    const capture = historyPanelSource.indexOf("const preservedExternalScrollTop", refreshStart);
    const loading = historyPanelSource.indexOf('setState({ kind: "loading" })', capture);
    const restore = historyPanelSource.indexOf("restoredScrollTopRef.current = preservedExternalScrollTop", loading);
    const rows = historyPanelSource.indexOf('setState({ kind: "ok", commits: data.commits', restore);
    expect(refreshStart).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(refreshStart);
    expect(loading).toBeGreaterThan(capture);
    expect(restore).toBeGreaterThan(loading);
    expect(rows).toBeGreaterThan(restore);
  });
});

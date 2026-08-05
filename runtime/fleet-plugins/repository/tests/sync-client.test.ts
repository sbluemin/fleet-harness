import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

// 2026-08-05 재가로 무상태 계약을 의도적으로 개정 — 수동 Sync는 결과를 표면화한다.
const railPanelSource = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
const historyPanelSource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");

describe("Repository sync client contracts", () => {
  it("surfaces a classified notice for manual sync failure", () => {
    expect(railPanelSource).toContain("setSyncNotice");
    expect(railPanelSource).toContain("auth_failed");
    expect(railPanelSource).toContain("network");
    expect(railPanelSource).toContain("timeout");
    expect(railPanelSource).toContain("no_remote");
    expect(railPanelSource).toContain("git_failed");
  });

  it("keeps throttle skips as a silent early return", () => {
    expect(railPanelSource).toContain('if ("skipped" in payload) return');
  });

  it("keeps auto mode silent for notice surfacing", () => {
    expect(railPanelSource).toContain('const isManual = mode !== "auto"');
    expect(railPanelSource).toContain("if (isManual)");
  });

  it("refreshes local data on successful fetch", () => {
    expect(railPanelSource).toContain("refreshRepositoryData()");
  });

  it("refreshes all local data bumpers while keeping History mounted", () => {
    const refreshStart = railPanelSource.indexOf("const refreshRepositoryData");
    const refreshEnd = railPanelSource.indexOf("const showSyncNotice", refreshStart);
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

import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatSyncAge } from "../client/rail-panel.js";
import { repositoryEn, repositoryKo } from "../client/i18n/messages.js";

const railPanelSource = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
const historyPanelSource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");

describe("Repository sync client contracts", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");

  it.each([
    [30_000, "just now", "방금"],
    [5 * 60_000, "5m ago", "5분 전"],
    [3 * 3_600_000, "3h ago", "3시간 전"],
    [2 * 86_400_000, "2d ago", "2일 전"],
  ])("formats an age of %i ms in English and Korean", (elapsed, english, korean) => {
    const timestamp = new Date(now - elapsed).toISOString();
    expect(formatSyncAge(timestamp, "en", now)).toBe(english);
    expect(formatSyncAge(timestamp, "ko", now)).toBe(korean);
  });

  it("pins the approved skipped-status copy in both locales", () => {
    expect(repositoryEn["repository.sync.status.skipped"]).toBe("Synced {age} · auto-sync skipped");
    expect(repositoryKo["repository.sync.status.skipped"]).toBe("{age} 동기화됨 · 자동 동기화 건너뜀");
  });

  it("pins the failed and up-to-date status copy in both locales", () => {
    expect(repositoryEn["repository.sync.status.failed"]).toBe("Fetch failed — showing local data");
    expect(repositoryKo["repository.sync.status.failed"]).toBe("fetch 실패 — 로컬 데이터 표시");
    expect(repositoryEn["repository.sync.status.upToDate"]).toBe("Synced just now · up to date");
    expect(repositoryKo["repository.sync.status.upToDate"]).toBe("방금 동기화됨 · 최신 상태");
  });

  it("separates network transport failures, unknown server failures, and no-op success", () => {
    expect(railPanelSource).toContain('if (state.error === "network") return t("repository.sync.status.networkError")');
    expect(railPanelSource).toContain('return t("repository.sync.status.failed")');
    expect(railPanelSource).toContain('state.pruned === 0 && state.newRefs === 0');
    expect(railPanelSource).toContain('setSyncState({ kind: "error", error: "network" })');
    expect(railPanelSource).toContain('payload.error ?? "git_failed"');
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

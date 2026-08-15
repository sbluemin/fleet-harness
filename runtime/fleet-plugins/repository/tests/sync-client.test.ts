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

  // 2026-08-15 재가 — 가져온 것이 없는 결과는 배너를 쓰지 않는다. 아이콘 ✓ 체류와 말풍선이 그 결과를 지고,
  // 갱신·실패만 배너로 남는다. 세 카운트가 0인 분기가 showSyncNotice로 되돌아가면 본문 이동이 부활한다.
  it("answers an up-to-date manual sync on the button instead of the banner", () => {
    expect(railPanelSource).toContain("if (newRefs === 0 && updatedRefs === 0 && pruned === 0) showSyncSettled();");
    expect(railPanelSource).toContain("else showSyncNotice({ kind: \"success\", newRefs, updatedRefs, pruned });");
    expect(railPanelSource).not.toContain("successClean");
    expect(railPanelSource).not.toContain("repository.sync.summaryClean");
  });

  // 한 시도의 답은 배너·✓·말풍선 세 표면에 나뉘어 앉는다. 새 시도가 셋을 함께 걷지 않으면 앞 시도의
  // 배너가 자기 6초를 사는 동안 뒤 시도의 ✓가 겹쳐 실패 배너와 "이미 최신 상태"가 동시에 뜬다.
  it("clears every per-attempt surface before the next manual attempt", () => {
    expect(railPanelSource).toContain("if (isManual) clearSyncSurfacing();");
    const start = railPanelSource.indexOf("const clearSyncSurfacing");
    const end = railPanelSource.indexOf("}, []);", start);
    const body = railPanelSource.slice(start, end);
    expect(body).toContain("syncNoticeTimerRef");
    expect(body).toContain("setSyncNotice(null)");
    expect(body).toContain("setSyncSettled(false)");
    expect(body).toContain("setSyncHintAvailable(false)");
    // 지속 실패 점은 시도별 알림이 아니라 "마지막 결과" 표식이므로 여기서 해제하지 않는다.
    expect(body).not.toContain("setSyncFailed");
  });

  it("keeps the up-to-date result announced and re-openable", () => {
    expect(railPanelSource).toContain("className=\"repository-sr-only\" role=\"status\"");
    expect(railPanelSource).toContain("repository.sync.upToDate");
    expect(railPanelSource).toContain("syncHintAvailable");
  });

  it("clears every sync surfacing timer on unmount and on repository transition", () => {
    for (const timer of ["syncNoticeTimerRef", "syncSettledTimerRef", "syncHintTimerRef"]) {
      const unmountStart = railPanelSource.indexOf("useEffect(() => () => {");
      const unmountEnd = railPanelSource.indexOf("}, []);", unmountStart);
      expect(railPanelSource.slice(unmountStart, unmountEnd), timer).toContain(timer);
      const transitionStart = railPanelSource.indexOf("const transitionRepository");
      const transitionEnd = railPanelSource.indexOf("setChangedFiles({ kind: \"loading\" })", transitionStart);
      expect(railPanelSource.slice(transitionStart, transitionEnd), timer).toContain(timer);
    }
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

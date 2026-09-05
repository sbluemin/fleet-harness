import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

// 2026-08-05 재가로 무상태 계약을 의도적으로 개정 — 수동 Sync는 결과를 표면화한다.
const railPanelSource = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
const historyPanelSource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");
const remoteSource = await fs.readFile(new URL("../server/remote.ts", import.meta.url), "utf8");

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

  // 2026-08-20 재가 — 툴바 동사(Pull/Push/Stash)의 결과에서 배너를 원천 제거했다. 성공·실패 모두
  // 그 동사의 버튼 자리에서 답한다(✓ 체류 · 말풍선 · coral 점). verbNotice/토스트가 되살아나면
  // "origin에서 canary를 pull했습니다" 같은 서술 블록이 다시 패널 본문을 밀어낸다.
  it("answers every toolbar verb on its own button, never in a banner", () => {
    expect(railPanelSource).not.toContain("verbNotice");
    expect(railPanelSource).not.toContain("setVerbNotice");
    expect(railPanelSource).not.toContain("repository.verb.pulled\"");
    expect(railPanelSource).not.toContain("repository.verb.pushed\"");
    // 결과는 높이가 고정된 공통 행에 남긴다. 일시 배너로 작업면을 밀지 않는다.
    expect(railPanelSource).not.toContain("repository-sync-toast");
    expect(railPanelSource).toContain("repository-feedback");
    expect(railPanelSource).toContain("setFeedback(outcome)");
    const verbRun = railPanelSource.slice(railPanelSource.indexOf("const runToolbarVerb"), railPanelSource.indexOf("const handlePull"));
    expect(verbRun).not.toContain("setSyncNotice");
    for (const handler of ["const handlePull", "const handlePush", "const handleStash ="]) {
      const start = railPanelSource.indexOf(handler);
      expect(start, handler).toBeGreaterThanOrEqual(0);
      expect(railPanelSource.slice(start, railPanelSource.indexOf("}, [", start)), handler).not.toContain("Notice");
    }
    expect(railPanelSource).toContain("showVerbOutcome");
    expect(railPanelSource).toContain("VerbToolbarButton");
    expect(railPanelSource).toContain("repository-sync-glyph repository-sync-glyph-settled");
  });

  // 성공 문면은 "무엇을 했다"가 아니라 "몇 커밋이 움직였다"여야 버튼 곁의 ahead/behind 계기와 함께 읽힌다.
  // 서버가 수를 세지 못한 경우를 0으로 단정하면 갱신을 "이미 최신 상태"라고 거짓말하게 된다.
  it("carries the substantive commit count, and never reads an unknown count as zero", () => {
    const start = railPanelSource.indexOf("function verbCountText");
    const body = railPanelSource.slice(start, railPanelSource.indexOf("\n}", start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain("repository.verb.pulledResult");
    expect(body).toContain("repository.verb.pushedResult");
    expect(body).toContain("repository.verb.upToDate");
    expect(body).toContain("repository.verb.pulledCount_one");
    expect(body).toContain("repository.verb.pushedCount_other");
    expect(body).toContain("count === null");
  });

  // 한 시도의 답은 ✓와 말풍선 두 표면에 나뉜다. 새 시도가 둘을 함께 걷지 않으면 앞 시도의 실패 문면과
  // 뒤 시도의 성공 ✓가 겹친다. 저장소 전환·언마운트도 같은 두 타이머를 걷어야 한다.
  it("clears both verb surfaces before the next attempt, on transition, and on unmount", () => {
    expect(railPanelSource).toContain("clearVerbSurfacing();");
    const clearStart = railPanelSource.indexOf("const clearVerbSurfacing");
    const clearBody = railPanelSource.slice(clearStart, railPanelSource.indexOf("}, []);", clearStart));
    expect(clearBody).toContain("setVerbOutcome(null)");
    expect(clearBody).toContain("setVerbSettled(false)");
    expect(clearBody).toContain("setVerbHinting(false)");
    for (const timer of ["verbSettledTimerRef", "verbHintTimerRef"]) {
      const unmountStart = railPanelSource.indexOf("useEffect(() => () => {");
      expect(railPanelSource.slice(unmountStart, railPanelSource.indexOf("}, []);", unmountStart)), timer).toContain(timer);
      const transitionStart = railPanelSource.indexOf("const transitionRepository");
      const transitionEnd = railPanelSource.indexOf("setChangedFiles({ kind: \"loading\" })", transitionStart);
      expect(railPanelSource.slice(transitionStart, transitionEnd), timer).toContain(timer);
    }
  });

  // 실패 문면은 조치를 담고 있어 성공보다 오래 머문다. 스크린 리더에도 같은 답이 가야 한다.
  it("keeps the verb outcome announced and its failure text longer-lived than success", () => {
    expect(railPanelSource).toContain("const VERB_ERROR_HINT_MS");
    expect(railPanelSource).toContain("outcome.kind === \"error\" ? VERB_ERROR_HINT_MS : SYNC_HINT_MS");
    // 동사 결과는 hover 재개방을 위해 남으므로, 한 리전을 동기화와 나눠 쓰면 남은 동사 문면이 뒤이은
    // 동기화 결과의 낭독을 영원히 가린다. 두 리전은 분리된 채로 있어야 한다.
    expect(railPanelSource).toContain("{syncHinting ? t(\"repository.sync.upToDate\") : \"\"}");
    expect(railPanelSource).toContain("{verbOutcome ? verbOutcome.text : \"\"}");
    expect(railPanelSource).not.toContain("verbOutcome.text : syncHinting");
  });

  // 2026-08-20 리뷰 — 보낸 커밋 수는 push 자신이 보고한 원격 ref 이동에서만 정직하다. 로컬 추적 ref는
  // 다른 체크아웃이 같은 커밋을 이미 민 경우 낡아 있어, 아무것도 보내지 않은 push를 "N개 보냄"으로 읽힌다.
  it("counts a push from the porcelain result, never from the local tracking ref", () => {
    expect(remoteSource).toContain("\"--porcelain\"");
    expect(remoteSource).toContain("parsePushOutcome");
    expect(remoteSource).not.toContain("@{upstream}..HEAD");
    expect(remoteSource).toContain("[up to date]");
  });

  // 2026-08-21 리뷰 — 스태시 "행" 동작(적용·적용 후 제거·삭제)은 툴바 동사가 아니다. 결과를 툴바 Stash
  // 버튼에 얹으면 "작업 중 변경 전체를 스태시" 버튼에 ✓·실패 점이 붙어, 누르지도 않은 명령에 답이 귀속된다.
  it("keeps stash row-action outcomes off the toolbar verb button", () => {
    const start = railPanelSource.indexOf("const handleStashRowAction");
    const body = railPanelSource.slice(start, railPanelSource.indexOf("}, [", start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(body).toContain("showRowNotice");
    expect(body).not.toContain("showVerbOutcome");
    expect(body).toContain("\"notice\"");
    // 행 알림 타이머도 전환·언마운트에서 함께 걷힌다.
    const unmountStart = railPanelSource.indexOf("useEffect(() => () => {");
    expect(railPanelSource.slice(unmountStart, railPanelSource.indexOf("}, []);", unmountStart))).toContain("rowNoticeTimerRef");
    const transitionStart = railPanelSource.indexOf("const transitionRepository");
    expect(railPanelSource.slice(transitionStart, railPanelSource.indexOf("setChangedFiles({ kind: \"loading\" })", transitionStart))).toContain("rowNoticeTimerRef");
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

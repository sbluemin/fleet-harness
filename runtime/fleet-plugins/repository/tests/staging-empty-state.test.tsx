// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StagingView } from "../client/staging-view.js";
import type { WorkstateResult } from "../server/types.js";
import type { RepositoryContext } from "../client/repository-context.js";
import { readCommitDraft, writeCommitDraft } from "../client/repository-state.js";

let host: HTMLDivElement;
let root: Root;
const onReturnToHistory = vi.fn();
const ctx = { theaterId: "empty-state-test", language: "en", api: { fetch: vi.fn() } } as unknown as RepositoryContext;
const props = { ctx, repoRel: "", workstate: null, onMutated: vi.fn(), onReturnToHistory, onBusyChange: vi.fn() };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onReturnToHistory.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ staged: [], unstaged: [] }), { status: 200 })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("변경 없음과 커밋 초안", () => {
  it("복원된 Amend 초안은 HEAD가 확인되기 전에는 실행할 수 없다", async () => {
    const draft = { subject: "이전 커밋 수정", body: "", amend: true, amendHeadSha: "old-head" };
    writeCommitDraft(ctx.theaterId!, "amend-pending", draft);
    await act(async () => root.render(createElement(StagingView, { ...props, repoRel: "amend-pending" })));
    expect(host.querySelector<HTMLButtonElement>(".repository-commit-button")?.disabled).toBe(true);
  });
  it("동일 HEAD는 복원하고 다른 HEAD는 메시지를 보존한 채 실행을 막는다", async () => {
    const draft = { subject: "원래 커밋 제목", body: "보존할 설명", amend: true, amendHeadSha: "original-head" };
    writeCommitDraft(ctx.theaterId!, "amend-advanced", draft);
    const workstate = { headSha: "original-head", indexLock: false, inProgress: null, stationedOperations: [] } as unknown as WorkstateResult;
    const render = (state: WorkstateResult) => root.render(createElement(StagingView, { ...props, repoRel: "amend-advanced", workstate: state }));
    await act(async () => render(workstate));
    expect(host.querySelector<HTMLButtonElement>(".repository-commit-button")?.disabled).toBe(false);
    await act(async () => render({ ...workstate, headSha: "new-head" }));
    expect(host.querySelector<HTMLButtonElement>(".repository-commit-button")?.disabled).toBe(true);
    expect(host.textContent).toContain("HEAD changed since this Amend draft");
    expect(host.querySelector<HTMLInputElement>(".repository-commit-subject")?.value).toBe(draft.subject);
    expect(readCommitDraft(ctx.theaterId!, "amend-advanced")?.amendHeadSha).toBe("original-head");
  });

  it("깨끗한 저장소에서는 커밋 폼 대신 기록 진입을 제공한다", async () => {
    await act(async () => root.render(createElement(StagingView, props)));
    expect(host.textContent).toContain("No changes to commit");
    expect(host.querySelector(".repository-commit-box")).toBeNull();
    const history = host.querySelector<HTMLButtonElement>(".repository-staging-empty button")!;
    await act(async () => history.click());
    expect(onReturnToHistory).toHaveBeenCalledOnce();
  });

  it("빈 목록이 잘린 응답이면 깨끗한 저장소로 단정하지 않는다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ staged: [], unstaged: [], truncated: true }), { status: 200 }));
    await act(async () => root.render(createElement(StagingView, props)));
    expect(host.querySelector(".repository-staging-empty")).toBeNull();
    expect(host.querySelector(".repository-truncated-note")).not.toBeNull();
  });

  it("체크아웃별 초안을 복원하되 깨끗해졌다고 기존 초안을 숨기지 않는다", async () => {
    writeCommitDraft(ctx.theaterId!, "draft-repo", { subject: "보존할 제목", body: "설명", amend: false });
    await act(async () => root.render(createElement(StagingView, { ...props, repoRel: "draft-repo" })));
    expect(host.querySelector<HTMLInputElement>(".repository-commit-subject")?.value).toBe("보존할 제목");
    expect(readCommitDraft(ctx.theaterId!, "draft-repo")?.body).toBe("설명");
  });

  it("상태 읽기 실패를 변경 없음으로 표시하지 않는다", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "git_failed" }), { status: 500 }));
    await act(async () => root.render(createElement(StagingView, props)));
    expect(host.querySelector(".repository-staging-empty")).toBeNull();
    expect(host.querySelector(".repository-sections-error")).not.toBeNull();
  });
});

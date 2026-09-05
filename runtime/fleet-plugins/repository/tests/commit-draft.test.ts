import { describe, expect, it } from "vitest";

import { readCommitDraft, writeCommitDraft } from "../client/repository-state.js";

describe("저장소별 커밋 초안", () => {
  it("같은 Theater의 서로 다른 체크아웃에 초안을 분리한다", () => {
    const first = { subject: "첫 번째 초안", body: "설명", amend: false };
    const second = { subject: "다른 초안", body: "", amend: true };
    writeCommitDraft("draft-test", "", first);
    writeCommitDraft("draft-test", "nested/repo", second);
    expect(readCommitDraft("draft-test", "")).toEqual(first);
    expect(readCommitDraft("draft-test", "nested/repo")).toEqual(second);
    expect(readCommitDraft("other-theater", "")).toBeUndefined();
  });

  it("빈 초안으로 저장하면 해당 저장소만 지운다", () => {
    writeCommitDraft("draft-clear", "one", { subject: "초안", body: "", amend: false });
    writeCommitDraft("draft-clear", "two", { subject: "유지", body: "", amend: false });
    writeCommitDraft("draft-clear", "one", { subject: "", body: "", amend: false });
    expect(readCommitDraft("draft-clear", "one")).toBeUndefined();
    expect(readCommitDraft("draft-clear", "two")?.subject).toBe("유지");
  });
});

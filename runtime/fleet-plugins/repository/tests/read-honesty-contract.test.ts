import { describe, expect, it } from "vitest";

import { REPOSITORY_MESSAGES, getT, readErrorSentence } from "../client/i18n/index.js";

describe("read failures speak in sentences", () => {
  const en = getT("en");
  const ko = getT("ko");

  it("maps every server read code to a sentence, never the code itself", () => {
    const codes = ["git_failed", "no_git_repo", "git_unavailable", "unknown_ref", "invalid_ref", "unknown_commit", "file_not_found", "unknown_path", "no_theater", "timeout", "git_timeout", "unknown", "something_new_from_the_server"];
    for (const code of codes) {
      for (const t of [en, ko]) {
        const sentence = readErrorSentence(t, code);
        expect(sentence).not.toContain(code);
        expect(sentence).not.toMatch(/^[a-z0-9]+(_[a-z0-9]+)+$/);
        expect(sentence.length).toBeGreaterThan(8);
      }
    }
  });

  it("names the next move for the failures that have one", () => {
    expect(readErrorSentence(en, "git_unavailable")).toMatch(/install git/i);
    expect(readErrorSentence(ko, "git_unavailable")).toContain("설치");
    expect(readErrorSentence(en, "git_failed")).toMatch(/try again/i);
    expect(readErrorSentence(ko, "git_failed")).toContain("다시 시도");
  });

  it("keeps an unknown code on the generic sentence rather than leaking it", () => {
    expect(readErrorSentence(en, "brand_new_code")).toBe(readErrorSentence(en, "unknown"));
  });
});

describe("honesty copy exists in both locales", () => {
  it("keeps en and ko key sets identical", () => {
    const enKeys = Object.keys(REPOSITORY_MESSAGES.en).sort();
    const koKeys = Object.keys(REPOSITORY_MESSAGES.ko).sort();
    expect(koKeys).toEqual(enKeys);
  });

  it("names the fetch verb after what it does, not after 'sync'", () => {
    // "Sync"는 대부분의 git UI에서 pull을 뜻한다. 이 컨트롤은 fetch --prune이므로 이름도 fetch여야 한다.
    expect(REPOSITORY_MESSAGES.en["repository.sync.button"]).toBe("Fetch");
    expect(REPOSITORY_MESSAGES.en["repository.sync.title"]).not.toContain("--prune");
    expect(REPOSITORY_MESSAGES.ko["repository.sync.title"]).not.toContain("--prune");
    // fetch 결과는 브랜치 발산이 아니라 원격 ref에 대해서만 말한다.
    expect(REPOSITORY_MESSAGES.en["repository.sync.upToDate"]).toMatch(/origin/);
    expect(REPOSITORY_MESSAGES.ko["repository.sync.upToDate"]).toContain("origin");
  });

  it("says what a destructive stash verb destroys", () => {
    expect(REPOSITORY_MESSAGES.en["repository.stash.pop"]).not.toBe("Pop");
    expect(REPOSITORY_MESSAGES.en["repository.stash.drop"]).toMatch(/delete/i);
    expect(REPOSITORY_MESSAGES.en["repository.stash.dropArm"]).toMatch(/delete/i);
    expect(REPOSITORY_MESSAGES.ko["repository.stash.dropArm"]).toContain("삭제");
  });

  it("separates deleting an untracked file from discarding tracked changes", () => {
    expect(REPOSITORY_MESSAGES.en["repository.staging.deleteUntracked"]).toMatch(/delete/i);
    expect(REPOSITORY_MESSAGES.en["repository.staging.deleteUntracked"]).not.toMatch(/discard/i);
    expect(REPOSITORY_MESSAGES.ko["repository.staging.deleteUntracked"]).toContain("삭제");
  });

  it("carries copy for every cap the server can report", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const key of ["repository.status.capped", "repository.commit.filesCapped", "repository.scan.limitReached", "repository.guard.stateUnknown"] as const) {
        expect(REPOSITORY_MESSAGES[locale][key].length).toBeGreaterThan(3);
      }
    }
  });
});

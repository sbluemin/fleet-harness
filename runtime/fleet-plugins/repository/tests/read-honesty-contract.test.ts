import fs from "node:fs/promises";

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
    // 이 컨트롤이 부르는 원격은 브랜치의 설정 원격이다 — origin이 아닐 수도, 없을 수도 있으므로
    // 어떤 문면도 원격 이름을 지어내지 않는다(server/fetch.ts resolveDefaultRemote).
    for (const locale of ["en", "ko"] as const) {
      for (const key of ["repository.sync.title", "repository.sync.upToDate", "repository.sync.failedAuth", "repository.sync.failedNetwork", "repository.sync.failedNoRemote", "repository.sync.failedTimeout", "repository.sync.failedGit"] as const) {
        expect(REPOSITORY_MESSAGES[locale][key]).not.toContain("origin");
      }
    }
    expect(REPOSITORY_MESSAGES.en["repository.sync.upToDate"]).toMatch(/remote/i);
    expect(REPOSITORY_MESSAGES.ko["repository.sync.upToDate"]).toContain("원격");
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

  it("does not blame the file list for a commit read the server only reports as truncated", () => {
    // server/commit.ts는 meta·name-status·numstat 세 truncated를 한 플래그로 OR한다.
    expect(REPOSITORY_MESSAGES.en["repository.commit.capped"]).not.toMatch(/file list/i);
    expect(REPOSITORY_MESSAGES.ko["repository.commit.capped"]).not.toContain("파일 목록");
  });

  it("carries copy for every cap the server can report", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const key of ["repository.status.capped", "repository.commit.capped", "repository.scan.limitReached", "repository.guard.stateUnknown"] as const) {
        expect(REPOSITORY_MESSAGES[locale][key].length).toBeGreaterThan(3);
      }
    }
  });
});

// 정직성은 사용자가 실제로 행동하는 표면에서만 성립한다 — 잘림 고지가 렌더되지 않는 컴포넌트에
// 앉아 있으면 "모두 스테이지"는 여전히 보이지 않는 나머지를 건드린다.
const stagingSource = await fs.readFile(new URL("../client/staging-view.tsx", import.meta.url), "utf8");

it("통합 선택기 카운터는 중복을 제외한 worktree 검색 결과도 센다", async () => {
  const source = await fs.readFile(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
  expect(source).toContain("const distinctWorktrees = worktrees.filter((worktree) => !repos.some((repo) => repo.relPath === worktree.relPath))");
  expect(source).toContain("const matchedWorktrees = distinctWorktrees.filter(matches)");
  expect(source).toContain("totalCount={repos.length + distinctWorktrees.length}");
  expect(source).toContain("matchedCount={rootRepos.length + nestedRepos.length + matchedWorktrees.length}");
});

describe("the staging surface carries its own honesty", () => {
  const source = stagingSource;

  it("keeps the status cap from the server and renders it beside the lists", () => {
    expect(source).toContain("...(result.truncated ? { truncated: true } : {})");
    expect(source).toContain('className="repository-truncated-note"');
    expect(source).toContain('t("repository.status.capped"');
  });

  it("re-reads the status when the panel reloads local repository state", () => {
    expect(source).toContain("reloadToken");
    expect(source).toMatch(/\[ctx\.api, ctx\.theaterId, repoRel, reloadToken, statusRetry\]/);
  });

  // 한 파일이 양쪽 축에 걸리면 parseStatusV2가 두 배열에 모두 넣는다 — 길이 합은 파일 수가 아니다.
  it("counts unique paths in the cap note, not list entries", () => {
    expect(source).toContain("new Set([...staged, ...unstaged].map((entry) => entry.path)).size");
    expect(source).not.toContain("count: staged.length + unstaged.length");
  });

  it("speaks a failed status read as a sentence", () => {
    expect(source).toContain("readErrorSentence(t, status.message)");
  });
});

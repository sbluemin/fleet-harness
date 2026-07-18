import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitExecutorError, runGit } from "../server/git-executor.js";

describe("runGit", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-repository-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("git 리포가 아닌 디렉터리에서 실행하면 no_git_repo 코드로 reject한다", async () => {
    await expect(
      runGit(["diff"], { cwd: tmpDir }),
    ).rejects.toSatisfy((err: unknown) =>
      err instanceof GitExecutorError && err.code === "no_git_repo",
    );
  });
});

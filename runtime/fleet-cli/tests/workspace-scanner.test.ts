import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkspaceChangeScanner, parseGitStatusPorcelainZ } from "../src/runtime/workspace-scanner.js";

const hasGit = (() => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const describeWithGit = hasGit ? describe : describe.skip;

describe("parseGitStatusPorcelainZ", () => {
	it("flattens rename records into one path string", () => {
		expect(parseGitStatusPorcelainZ("R  new.ts\0old.ts\0")).toEqual([
			{ status: "R", path: "old.ts -> new.ts" },
		]);
	});

	it("returns null for malformed rename records", () => {
		expect(parseGitStatusPorcelainZ("R  new.ts\0")).toBeNull();
	});
});

describeWithGit("createWorkspaceChangeScanner", () => {
	it("returns null for a non-git directory", async () => {
		const dir = makeTempDir("fleet-scanner-nonrepo-");
		try {
			await expect(createWorkspaceChangeScanner().snapshot(dir)).resolves.toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects modified, untracked, deleted, and renamed paths", async () => {
		const dir = makeTempDir("fleet-scanner-repo-");
		try {
			runGit(dir, "init");
			runGit(dir, "config", "user.email", "fleet@example.com");
			runGit(dir, "config", "user.name", "Fleet Test");
			writeFileSync(path.join(dir, "modified.txt"), "before\n");
			writeFileSync(path.join(dir, "deleted.txt"), "delete me\n");
			writeFileSync(path.join(dir, "old.txt"), "rename me\n");
			runGit(dir, "add", ".");
			runGit(dir, "commit", "-m", "seed");

			writeFileSync(path.join(dir, "modified.txt"), "after\n");
			rmSync(path.join(dir, "deleted.txt"));
			writeFileSync(path.join(dir, "untracked.txt"), "new\n");
			mkdirSync(path.join(dir, "new-dir"));
			writeFileSync(path.join(dir, "new-dir", "nested.txt"), "nested\n");
			runGit(dir, "mv", "old.txt", "new.txt");

			const snapshot = await createWorkspaceChangeScanner().snapshot(dir);

			expect(snapshot).toEqual(expect.arrayContaining([
				{ status: "M", path: "modified.txt" },
				{ status: "D", path: "deleted.txt" },
				{ status: "??", path: "untracked.txt" },
				// 신규 디렉토리 내 파일이 "?? new-dir/"로 접히지 않고 개별 경로로 열거되어야 한다.
				{ status: "??", path: "new-dir/nested.txt" },
				{ status: "R", path: "old.txt -> new.txt" },
			]));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function runGit(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

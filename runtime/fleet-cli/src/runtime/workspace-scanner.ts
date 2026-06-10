import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { WorkspaceChangeScanner, WorkspaceChangeSnapshotEntry } from "@dotobokuri/fleet-carriers";

const execFileAsync = promisify(execFile);
const GIT_STATUS_TIMEOUT_MS = 4_000;
const GIT_STATUS_MAX_BUFFER = 1024 * 1024;

export function createWorkspaceChangeScanner(): WorkspaceChangeScanner {
	return {
		async snapshot(cwd) {
			try {
				const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], {
					cwd,
					encoding: "utf8",
					maxBuffer: GIT_STATUS_MAX_BUFFER,
					timeout: GIT_STATUS_TIMEOUT_MS,
				});
				return parseGitStatusPorcelainZ(stdout);
			} catch {
				return null;
			}
		},
	};
}

export function parseGitStatusPorcelainZ(output: string): WorkspaceChangeSnapshotEntry[] | null {
	try {
		const tokens = output.split("\0").filter((token) => token.length > 0);
		const entries: WorkspaceChangeSnapshotEntry[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			if (token.length < 4) continue;
			const status = token.slice(0, 2).trim();
			const path = token.slice(3);
			if (!status || !path) continue;
			if (status.startsWith("R") || status.startsWith("C")) {
				const oldPath = tokens[++i];
				if (!oldPath) return null;
				entries.push({ status, path: `${oldPath} -> ${path}` });
			} else {
				entries.push({ status, path });
			}
		}
		return entries;
	} catch {
		return null;
	}
}

import { spawn } from "child_process";
import { getFleetRoot } from "../config.js";
import { shouldUseWindowsShell } from "./child-process.js";

export interface FleetUpdateStatus {
	behind: number;
	branch: string;
	fleetRoot: string;
	hasRemote: boolean;
	upstream?: string;
	version: string;
}

const DEFAULT_GIT_TIMEOUT_MS = 10000;

function runGitCommand(cwd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			shell: shouldUseWindowsShell("git"),
		});

		let stdout = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve(undefined);
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0 ? stdout.trim() || undefined : undefined);
		});
	});
}

export async function getFleetUpdateStatus(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<FleetUpdateStatus | undefined> {
	const fleetRoot = getFleetRoot();
	if (!fleetRoot) {
		return undefined;
	}

	const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	const branch = await runGitCommand(fleetRoot, ["rev-parse", "--abbrev-ref", "HEAD"], timeoutMs);
	if (!branch) {
		return undefined;
	}

	await runGitCommand(fleetRoot, ["fetch"], timeoutMs);

	const upstream = await runGitCommand(
		fleetRoot,
		["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
		timeoutMs,
	);
	if (!upstream) {
		return {
			behind: 0,
			branch,
			fleetRoot,
			hasRemote: false,
			version: currentVersion,
		};
	}

	const behindRaw = await runGitCommand(fleetRoot, ["rev-list", "HEAD..@{u}", "--count"], timeoutMs);
	const behind = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
	return {
		behind: Number.isFinite(behind) ? behind : 0,
		branch,
		fleetRoot,
		hasRemote: true,
		upstream,
		version: currentVersion,
	};
}

export async function checkForFleetUpdate(currentVersion: string): Promise<FleetUpdateStatus | undefined> {
	try {
		const status = await getFleetUpdateStatus(currentVersion);
		if (!status || !status.hasRemote || status.behind <= 0) {
			return undefined;
		}
		return status;
	} catch {
		return undefined;
	}
}

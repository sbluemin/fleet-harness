import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { main } from "../src/main.js";

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPath: string | undefined;
	let originalFleetUpdateRecord: string | undefined;
	let originalFleetUpdateState: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPath = process.env.PATH;
		originalFleetUpdateRecord = process.env.FLEET_UPDATE_RECORD;
		originalFleetUpdateState = process.env.FLEET_UPDATE_STATE;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalFleetUpdateRecord === undefined) {
			delete process.env.FLEET_UPDATE_RECORD;
		} else {
			process.env.FLEET_UPDATE_RECORD = originalFleetUpdateRecord;
		}
		if (originalFleetUpdateState === undefined) {
			delete process.env.FLEET_UPDATE_STATE;
		} else {
			process.env.FLEET_UPDATE_STATE = originalFleetUpdateState;
		}
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	function setupFleetCheckout(options: {
		behind?: number;
		hasRemote?: boolean;
		installExitCode?: number;
		pullExitCode?: number;
	} = {}): { recordPath: string; root: string } {
		const root = join(tempDir, "fleet-checkout");
		const selfPackageDir = join(root, "engines", "packages", "coding-agent");
		const extensionPackageDir = join(root, "packages", "fleet-harness");
		const binDir = join(tempDir, "bin");
		const recordPath = join(tempDir, "fleet-update-record.json");
		const statePath = join(tempDir, "fleet-update-state.json");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(extensionPackageDir, { recursive: true });
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
		writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - engines/packages/*\n  - packages/*\n");
		writeFileSync(join(selfPackageDir, "package.json"), "{}\n");
		writeFileSync(join(extensionPackageDir, "package.json"), "{}\n");
		writeFileSync(
			statePath,
			JSON.stringify({
				behind: options.behind ?? 0,
				hasRemote: options.hasRemote ?? true,
				installExitCode: options.installExitCode ?? 0,
				pullExitCode: options.pullExitCode ?? 0,
				root,
			}),
		);
		writeFileSync(
			join(binDir, "git"),
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const recordPath = process.env.FLEET_UPDATE_RECORD;
const state = JSON.parse(fs.readFileSync(process.env.FLEET_UPDATE_STATE, "utf-8"));
const records = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf-8")) : [];
records.push({ command: "git", args, cwd: process.cwd() });
fs.writeFileSync(recordPath, JSON.stringify(records));
if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
  console.log(state.root);
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
  console.log("main");
  process.exit(0);
}
if (args[0] === "fetch") {
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{u}") {
  if (!state.hasRemote) process.exit(1);
  console.log("origin/main");
  process.exit(0);
}
if (args[0] === "rev-list" && args[1] === "HEAD..@{u}" && args[2] === "--count") {
  console.log(String(state.behind));
  process.exit(0);
}
if (args[0] === "pull" && args[1] === "--ff-only") {
  process.exit(state.pullExitCode);
}
process.exit(0);
`,
		);
		writeFileSync(
			join(binDir, "pnpm"),
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const recordPath = process.env.FLEET_UPDATE_RECORD;
const state = JSON.parse(fs.readFileSync(process.env.FLEET_UPDATE_STATE, "utf-8"));
const records = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, "utf-8")) : [];
records.push({ command: "pnpm", args, cwd: process.cwd() });
fs.writeFileSync(recordPath, JSON.stringify(records));
process.exit(state.installExitCode ?? 0);
`,
		);
		chmodSync(join(binDir, "git"), 0o755);
		chmodSync(join(binDir, "pnpm"), 0o755);
		process.env.FLEET_UPDATE_RECORD = recordPath;
		process.env.FLEET_UPDATE_STATE = statePath;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});
		return { recordPath, root };
	}

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("fleet install <source> [-l]");
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain('Use "fleet --help" or "fleet install <source> [-l]".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain("Usage: fleet install <source> [-l]");
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("runs forced self-update with git pull and pnpm install in the Fleet root", async () => {
		const { recordPath, root } = setupFleetCheckout({ behind: 0 });
		const expectedRoot = realpathSync(root);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self", "--force"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const records = JSON.parse(readFileSync(recordPath, "utf-8")) as Array<{
				args: string[];
				command: string;
				cwd: string;
			}>;
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ command: "git", args: ["rev-parse", "--show-toplevel"] }),
					expect.objectContaining({ command: "git", args: ["pull", "--ff-only"], cwd: expectedRoot }),
					expect.objectContaining({ command: "pnpm", args: ["install"], cwd: expectedRoot }),
				]),
			);
			expect(records.find((record) => record.args[0] === "fetch")).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("checks git-behind status before non-forced self-update and then updates the Fleet checkout", async () => {
		const { recordPath, root } = setupFleetCheckout({ behind: 2 });
		const expectedRoot = realpathSync(root);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const records = JSON.parse(readFileSync(recordPath, "utf-8")) as Array<{
				args: string[];
				command: string;
				cwd: string;
			}>;
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ command: "git", args: ["fetch"], cwd: expectedRoot }),
					expect.objectContaining({
						command: "git",
						args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
						cwd: expectedRoot,
					}),
					expect.objectContaining({
						command: "git",
						args: ["rev-list", "HEAD..@{u}", "--count"],
						cwd: expectedRoot,
					}),
					expect.objectContaining({ command: "git", args: ["pull", "--ff-only"], cwd: expectedRoot }),
					expect.objectContaining({ command: "pnpm", args: ["install"], cwd: expectedRoot }),
				]),
			);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("fails gracefully when the Fleet checkout has no tracked upstream branch", async () => {
		const { recordPath, root } = setupFleetCheckout({ hasRemote: false });
		const expectedRoot = realpathSync(root);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("cannot self-update this installation");
			expect(stderr).toContain("tracked upstream branch");
			const records = JSON.parse(readFileSync(recordPath, "utf-8")) as Array<{
				args: string[];
				command: string;
				cwd: string;
			}>;
			expect(records).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ command: "git", args: ["fetch"], cwd: expectedRoot }),
				]),
			);
			expect(records.find((record) => record.args[0] === "pull")).toBeUndefined();
			expect(records.find((record) => record.command === "pnpm")).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("keeps --extensions on the package-manager path without invoking self-update", async () => {
		const { recordPath } = setupFleetCheckout({ behind: 4 });

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update", "--extensions"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("Updated packages");
			expect(() => readFileSync(recordPath, "utf-8")).toThrow();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:pi-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["update", "pi-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:pi-formatter?");
			expect(stdout).not.toContain("Updated pi-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:pi-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});

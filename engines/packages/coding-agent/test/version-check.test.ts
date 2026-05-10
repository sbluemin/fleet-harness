import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkForFleetUpdate, getFleetUpdateStatus } from "../src/utils/version-check.js";

const originalPath = process.env.PATH;
const originalFleetUpdateRecord = process.env.FLEET_UPDATE_RECORD;
const originalFleetUpdateState = process.env.FLEET_UPDATE_STATE;
let tempDir: string | undefined;

function setupFleetGitFixture(behind: number, hasRemote: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "fleet-version-check-"));
	const packageDir = join(root, "engines", "packages", "coding-agent");
	const extensionPackageDir = join(root, "packages", "fleet-harness");
	const binDir = join(root, "bin");
	const statePath = join(root, "fleet-update-state.json");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(extensionPackageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
	writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - engines/packages/*\n  - packages/*\n");
	writeFileSync(join(packageDir, "package.json"), "{}\n");
	writeFileSync(join(extensionPackageDir, "package.json"), "{}\n");
	writeFileSync(
		statePath,
		JSON.stringify({
			behind,
			hasRemote,
			root,
		}),
	);
	writeFileSync(
		join(binDir, "git"),
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FLEET_UPDATE_STATE, "utf-8"));
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
process.exit(0);
`,
	);
	chmodSync(join(binDir, "git"), 0o755);
	tempDir = root;
	process.env.FLEET_UPDATE_STATE = statePath;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	return root;
}

afterEach(() => {
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
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("version checks", () => {
	it("returns Fleet git status when the checkout is behind its upstream", async () => {
		const root = setupFleetGitFixture(3, true);

		await expect(getFleetUpdateStatus("1.2.3")).resolves.toEqual({
			behind: 3,
			branch: "main",
			fleetRoot: root,
			hasRemote: true,
			upstream: "origin/main",
			version: "1.2.3",
		});
	});

	it("returns only actionable Fleet updates", async () => {
		setupFleetGitFixture(0, true);
		await expect(checkForFleetUpdate("1.2.3")).resolves.toBeUndefined();

		setupFleetGitFixture(2, true);
		await expect(checkForFleetUpdate("1.2.3")).resolves.toEqual(
			expect.objectContaining({ behind: 2, branch: "main", upstream: "origin/main" }),
		);
	});

	it("treats checkouts without a tracked upstream as unavailable", async () => {
		const root = setupFleetGitFixture(0, false);

		await expect(getFleetUpdateStatus("1.2.3")).resolves.toEqual({
			behind: 0,
			branch: "main",
			fleetRoot: root,
			hasRemote: false,
			version: "1.2.3",
		});
		await expect(checkForFleetUpdate("1.2.3")).resolves.toBeUndefined();
	});
});

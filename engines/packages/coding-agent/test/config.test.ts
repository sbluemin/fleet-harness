import { spawnSync } from "child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createJiti } from "jiti";
import { afterEach, describe, expect, test } from "vitest";

type LoadedConfigModule = typeof import("../src/config.js");

const SOURCE_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;

let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

function writeFixturePackage(packageDir: string): void {
	mkdirSync(join(packageDir, "src", "utils"), { recursive: true });
	writeFileSync(join(packageDir, "package.json"), "{}\n");
	copyFileSync(join(SOURCE_PACKAGE_DIR, "src/config.ts"), join(packageDir, "src/config.ts"));
	copyFileSync(
		join(SOURCE_PACKAGE_DIR, "src/utils/child-process.ts"),
		join(packageDir, "src/utils/child-process.ts"),
	);
}

async function loadConfigModule(packageDir: string): Promise<LoadedConfigModule> {
	const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
	return (await jiti.import(pathToFileURL(join(packageDir, "src/config.ts")).href)) as LoadedConfigModule;
}

function createStandalonePackage(template = "pi-config-"): string {
	const root = mkdtempSync(join(tmpdir(), template));
	const packageDir = join(root, "package");
	writeFixturePackage(packageDir);
	tempDir = root;
	return packageDir;
}

function createNpmPrefixInstall(
	template = "pi-prefix-",
	packageName = "@earendil-works/pi-coding-agent",
): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const [scope, name = packageName] = packageName.split("/");
	const packageDir = scope.startsWith("@") ? join(root, scope, name) : join(root, packageName);
	writeFixturePackage(packageDir);
	tempDir = prefix;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "pi-coding-agent");
	writeFixturePackage(packageDir);
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	setExecPath(
		join(
			root,
			".pnpm",
			"@mariozechner+pi-coding-agent@0.0.0",
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"dist",
			"cli.js",
		),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "pi-coding-agent");
	writeFixturePackage(packageDir);
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "pi-coding-agent", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "pi-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "pi-coding-agent");
	writeFixturePackage(packageDir);
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFleetRepoInstall(withGit: boolean): { root: string; packageDir: string } {
	const root = mkdtempSync(join(tmpdir(), "fleet-root-"));
	const packageDir = join(root, "engines", "packages", "coding-agent");
	const extensionPackageDir = join(root, "packages", "fleet-harness-extension");
	writeFixturePackage(packageDir);
	mkdirSync(extensionPackageDir, { recursive: true });
	writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
	writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - engines/packages/*\n  - packages/*\n");
	writeFileSync(join(extensionPackageDir, "package.json"), "{}\n");
	if (withGit) {
		const result = spawnSync("git", ["init"], {
			cwd: root,
			stdio: "ignore",
		});
		expect(result.status).toBe(0);
	}
	tempDir = root;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { root, packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("detectInstallMethod", () => {
	test("resolves fleet root changelog from git repository installs", async () => {
		const { packageDir, root } = createFleetRepoInstall(true);
		const config = await loadConfigModule(packageDir);
		const expectedRoot = realpathSync(root);

		expect(config.getFleetRoot()).toBe(expectedRoot);
		expect(config.getChangelogPath()).toBe(join(expectedRoot, "CHANGELOG.md"));
	});

	test("falls back to fleet markers when git metadata is unavailable", async () => {
		const { packageDir, root } = createFleetRepoInstall(false);
		const config = await loadConfigModule(packageDir);

		expect(config.getFleetRoot()).toBe(resolve(root));
		expect(config.getChangelogPath()).toBe(resolve(join(root, "CHANGELOG.md")));
	});

	test("detects pnpm from Windows .pnpm install paths", async () => {
		const config = await loadConfigModule(createStandalonePackage());
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+pi-coding-agent@0.67.68\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
		);

		expect(config.detectInstallMethod()).toBe("pnpm");
		expect(config.getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: pnpm install -g @earendil-works/pi-coding-agent",
		);
	});

	test("does not self-update unknown wrapper installs", async () => {
		const config = await loadConfigModule(createStandalonePackage());
		setExecPath("/usr/local/bin/node");

		expect(config.detectInstallMethod()).toBe("unknown");
		expect(config.getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
		expect(config.getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Update @earendil-works/pi-coding-agent using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("self-updates npm installs from custom prefixes", async () => {
		const { prefix, packageDir } = createNpmPrefixInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(config.detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"],
			display: `npm --prefix ${prefix} install -g @earendil-works/pi-coding-agent`,
		});
	});

	test("self-updates renamed packages from the current install prefix", async () => {
		const { prefix, packageDir } = createNpmPrefixInstall("pi-prefix-", "@mariozechner/pi-coding-agent");
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@new-scope/pi"],
			display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent && npm --prefix ${prefix} install -g @new-scope/pi`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: `npm --prefix ${prefix} uninstall -g @mariozechner/pi-coding-agent`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "@new-scope/pi"],
					display: `npm --prefix ${prefix} install -g @new-scope/pi`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", async () => {
		const { prefix, packageDir } = createNpmPrefixInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@earendil-works/pi-coding-agent", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"],
			display: `npm --prefix ${prefix} install -g @earendil-works/pi-coding-agent`,
		});
	});

	test("self-update treats empty npmCommand as unset", async () => {
		const { prefix, packageDir } = createNpmPrefixInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@earendil-works/pi-coding-agent", []);

		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", "@earendil-works/pi-coding-agent"]);
	});

	test("quotes npm self-update display paths", async () => {
		const { prefix, packageDir } = createNpmPrefixInstall("pi prefix ");
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(command?.display).toBe(`npm --prefix "${prefix}" install -g @earendil-works/pi-coding-agent`);
	});

	test("does not infer Windows npm custom prefixes from package paths", async () => {
		const config = await loadConfigModule(createStandalonePackage());
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\pi-coding-agent";
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(config.detectInstallMethod()).toBe("npm");
		expect(config.getUpdateInstruction("@earendil-works/pi-coding-agent")).toBe(
			"Run: npm install -g @earendil-works/pi-coding-agent",
		);
	});

	test("self-updates bun global installs from bun pm bin", async () => {
		const { packageDir } = createBunGlobalInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@earendil-works/pi-coding-agent");

		expect(config.detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@earendil-works/pi-coding-agent"],
			display: "bun install -g @earendil-works/pi-coding-agent",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", async () => {
		const { packageDir } = createPnpmGlobalInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(config.detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "@new-scope/pi"],
			display: "pnpm remove -g @mariozechner/pi-coding-agent && pnpm install -g @new-scope/pi",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/pi-coding-agent"],
					display: "pnpm remove -g @mariozechner/pi-coding-agent",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "@new-scope/pi"],
					display: "pnpm install -g @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", async () => {
		const { packageDir } = createYarnGlobalInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(config.detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "@new-scope/pi"],
			display: "yarn global remove @mariozechner/pi-coding-agent && yarn global add @new-scope/pi",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/pi-coding-agent"],
					display: "yarn global remove @mariozechner/pi-coding-agent",
				},
				{
					command: "yarn",
					args: ["global", "add", "@new-scope/pi"],
					display: "yarn global add @new-scope/pi",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", async () => {
		const { packageDir } = createBunGlobalInstall();
		const config = await loadConfigModule(packageDir);
		const command = config.getSelfUpdateCommand("@mariozechner/pi-coding-agent", undefined, "@new-scope/pi");

		expect(config.detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@new-scope/pi"],
			display: "bun uninstall -g @mariozechner/pi-coding-agent && bun install -g @new-scope/pi",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/pi-coding-agent"],
					display: "bun uninstall -g @mariozechner/pi-coding-agent",
				},
				{
					command: "bun",
					args: ["install", "-g", "@new-scope/pi"],
					display: "bun install -g @new-scope/pi",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", async () => {
		const { packageDir } = createNpmPrefixInstall();
		const config = await loadConfigModule(packageDir);
		chmodSync(packageDir, 0o500);

		try {
			expect(config.getSelfUpdateCommand("@earendil-works/pi-coding-agent")).toBeUndefined();
			expect(config.getSelfUpdateUnavailableInstruction("@earendil-works/pi-coding-agent")).toContain(
				"the install path is not writable",
			);
		} finally {
			chmodSync(packageDir, 0o700);
		}
	});
});

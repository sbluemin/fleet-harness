import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FLEET_CLI_PACKAGE = "@dotobokuri/fleet-cli";
export const FLEET_CONSOLE_PACKAGE = "@dotobokuri/fleet-console";
export const MIGRATION_BRIDGE_MARKER = "fleetMigrationBridge";
export const DEPRECATION_MESSAGE =
  "Fleet CLI moved to @dotobokuri/fleet-console; install that package instead.";

const REPO_URL = "git+https://github.com/sbluemin/fleet-harness.git";
const HOMEPAGE = "https://github.com/sbluemin/fleet-harness#readme";
const BUGS_URL = "https://github.com/sbluemin/fleet-harness/issues";
const LICENSE = "MIT";
const ENGINES = Object.freeze({ node: ">=20.19.0" });

export function parseArgs(argv) {
  const args = argv ?? [];
  return {
    tag: args.find((a) => a.startsWith("--tag="))?.slice("--tag=".length) ?? "latest",
    version: args.find((a) => a.startsWith("--version="))?.slice("--version=".length),
    dryRun: args.includes("--dry-run"),
  };
}

export function createMigrationBridgeManifest(version) {
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("--version=<semver> is required");
  }
  return {
    name: FLEET_CLI_PACKAGE,
    version,
    description:
      "Migration bridge: Fleet CLI runtime and bins moved to @dotobokuri/fleet-console.",
    license: LICENSE,
    [MIGRATION_BRIDGE_MARKER]: true,
    repository: {
      type: "git",
      url: REPO_URL,
    },
    homepage: HOMEPAGE,
    bugs: { url: BUGS_URL },
    engines: { ...ENGINES },
    dependencies: {
      [FLEET_CONSOLE_PACKAGE]: version,
    },
  };
}

export function createMigrationBridgeReadme() {
  return [
    "# @dotobokuri/fleet-cli",
    "",
    "The Fleet CLI runtime and bins moved to `@dotobokuri/fleet-console`.",
    "",
    "Install that package instead:",
    "",
    "```sh",
    "npm install -g @dotobokuri/fleet-console",
    "```",
    "",
    "This package is exact-version migration metadata with no bin and no runtime code.",
    "Each stable Console release publishes a matching bridge version.",
    "",
  ].join("\n");
}

export function shouldPublishBridgeForTag(tag) {
  return tag === "latest";
}

function runNpm(argv, { cwd, execFile = execFileSync, dryRun = false, action } = {}) {
  if (dryRun) {
    console.log(`[dry-run] npm ${argv.join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  try {
    const stdout = execFile("npm", argv, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: stdout ?? "", stderr: "" };
  } catch (error) {
    if (typeof error.status === "number") {
      return {
        status: error.status,
        stdout: error.stdout?.toString?.() ?? "",
        stderr: error.stderr?.toString?.() ?? String(error.message ?? error),
      };
    }
    throw new Error(`${action ?? "npm"} failed: ${error.message ?? error}`);
  }
}

function parseNpmJsonView(result) {
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status !== 0) {
    return { exists: false, value: undefined };
  }
  if (text === "" || text === "undefined" || text === "null") {
    return { exists: true, value: undefined };
  }
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch {
    return { exists: true, value: text };
  }
}

export function packageViewExists(packageSpec, field, { execFile = execFileSync } = {}) {
  const fields = field ? [field] : [];
  const result = runNpm(
    ["view", packageSpec, ...fields, "--json"],
    { execFile, action: `npm view ${packageSpec}` },
  );
  return parseNpmJsonView(result);
}

export function ensureConsolePublished(version, { execFile = execFileSync } = {}) {
  const viewed = packageViewExists(`${FLEET_CONSOLE_PACKAGE}@${version}`, "version", { execFile });
  if (!viewed.exists) {
    throw new Error(
      `${FLEET_CONSOLE_PACKAGE}@${version} is not published; publish Console before the migration bridge.`,
    );
  }
}

export function deprecateBridgeVersion(version, { execFile = execFileSync, dryRun = false } = {}) {
  const result = runNpm(
    ["deprecate", `${FLEET_CLI_PACKAGE}@${version}`, DEPRECATION_MESSAGE],
    {
      execFile,
      dryRun,
      action: `npm deprecate ${FLEET_CLI_PACKAGE}@${version}`,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to deprecate ${FLEET_CLI_PACKAGE}@${version}: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  console.log(`Deprecated ${FLEET_CLI_PACKAGE}@${version}.`);
}

export function publishMigrationBridgePackage(version, {
  execFile = execFileSync,
  dryRun = false,
  mkdtemp = mkdtempSync,
  writeFile = writeFileSync,
  remove = rmSync,
  tempRoot = tmpdir(),
} = {}) {
  const manifest = createMigrationBridgeManifest(version);
  const readme = createMigrationBridgeReadme();
  const dir = mkdtemp(path.join(tempRoot, "fleet-cli-migration-bridge-"));
  try {
    writeFile(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFile(path.join(dir, "README.md"), readme);
    const result = runNpm(
      ["publish", "--tag", "latest", "--access", "public"],
      {
        cwd: dir,
        execFile,
        dryRun,
        action: `npm publish ${FLEET_CLI_PACKAGE}@${version}`,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Failed to publish ${FLEET_CLI_PACKAGE}@${version}: ${result.stderr || result.stdout || "unknown error"}`,
      );
    }
    console.log(`Published ${FLEET_CLI_PACKAGE}@${version} migration bridge.`);
  } finally {
    remove(dir, { recursive: true, force: true });
  }
}

export async function publishFleetCliMigrationBridge(options = {}) {
  const {
    tag = "latest",
    version,
    dryRun = false,
    execFile = execFileSync,
    mkdtemp = mkdtempSync,
    writeFile = writeFileSync,
    remove = rmSync,
    tempRoot = tmpdir(),
    log = console.log,
  } = options;

  if (!shouldPublishBridgeForTag(tag)) {
    log(
      `Skipping @dotobokuri/fleet-cli migration bridge publish for --tag=${tag}; bridge publishes only for latest.`,
    );
    return { status: "skipped-non-latest", published: false, deprecated: false };
  }

  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("--version=<semver> is required");
  }

  ensureConsolePublished(version, { execFile });

  const target = packageViewExists(
    `${FLEET_CLI_PACKAGE}@${version}`,
    MIGRATION_BRIDGE_MARKER,
    { execFile },
  );
  if (target.exists) {
    if (target.value === true) {
      log(`${FLEET_CLI_PACKAGE}@${version} already published as the migration bridge; ensuring deprecation.`);
      deprecateBridgeVersion(version, { execFile, dryRun });
      return {
        status: "idempotent-existing-bridge",
        published: false,
        deprecated: true,
        bridgeVersion: version,
      };
    }
    throw new Error(
      `${FLEET_CLI_PACKAGE}@${version} already exists without ${MIGRATION_BRIDGE_MARKER}=true; refusing to overwrite or relabel it as a bridge.`,
    );
  }

  publishMigrationBridgePackage(version, {
    execFile,
    dryRun,
    mkdtemp,
    writeFile,
    remove,
    tempRoot,
  });
  deprecateBridgeVersion(version, { execFile, dryRun });
  return {
    status: "published",
    published: true,
    deprecated: true,
    bridgeVersion: version,
  };
}

async function main(argv = process.argv.slice(2)) {
  const { tag, version, dryRun } = parseArgs(argv);
  await publishFleetCliMigrationBridge({ tag, version, dryRun });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, "../runtime/fleet-console/package.json");
const BACKUP_PATH = path.resolve(__dirname, "../runtime/fleet-console/.package.json.prepack-backup");
const TEMP_PATH = path.resolve(__dirname, "../runtime/fleet-console/.package.json.prepack-tmp");
// 번들에 인라인되지 않고 산출물이 그대로 해석하려 드는 의존성. 빠뜨리면 게시본이 설치처에서
// ERR_MODULE_NOT_FOUND로 죽으므로, check-dist-published-externals.mjs가 빌드마다 dist와 대조한다.
const EXTERNAL_DEP_NAMES = ["node-pty", "ws", "font-list", "@anthropic-ai/claude-agent-sdk", "@vscode/ripgrep", "selfsigned", "esbuild"];

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];

  if (action === "prepack") {
    prepack();
  } else if (action === "postpack") {
    postpack();
  } else {
    throw new Error("Usage: pack-fleet-console-manifest.mjs <prepack|postpack>");
  }
}

export function createPublishedFleetConsoleManifest(originalPkg) {
  const pkg = JSON.parse(JSON.stringify(originalPkg));
  const externalDeps = {};
  for (const name of EXTERNAL_DEP_NAMES) {
    const range = pkg.dependencies?.[name];
    if (!range) throw new Error(`external dependency ${name} not found in ${PKG_PATH}`);
    externalDeps[name] = range;
  }
  delete pkg.private;
  pkg.dependencies = externalDeps;
  pkg.scripts = { postinstall: "node postinstall.mjs" };
  stripWorkspaceDependencySpecifiers(pkg);
  return pkg;
}

function prepack() {
  if (existsSync(BACKUP_PATH)) {
    postpack();
  }
  const original = readFileSync(PKG_PATH, "utf8");
  let backupCreated = false;
  try {
    atomicWrite(BACKUP_PATH, original);
    backupCreated = true;
    const pkg = createPublishedFleetConsoleManifest(JSON.parse(original));
    atomicWrite(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (error) {
    if (backupCreated) {
      restoreBackup();
    }
    throw error;
  }
}

function postpack() {
  if (!existsSync(BACKUP_PATH)) return;
  restoreBackup();
}

function restoreBackup() {
  if (!existsSync(BACKUP_PATH)) return;
  atomicWrite(PKG_PATH, readFileSync(BACKUP_PATH, "utf8"));
  rmSync(BACKUP_PATH, { force: true });
}

function atomicWrite(targetPath, content) {
  writeFileSync(TEMP_PATH, content);
  renameSync(TEMP_PATH, targetPath);
}

function stripWorkspaceDependencySpecifiers(pkg) {
  for (const [section, entries] of Object.entries(pkg)) {
    if (!section.endsWith("Dependencies") || entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value === "string" && value.startsWith("workspace:")) delete entries[name];
    }
  }
}

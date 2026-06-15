import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, "../runtime/fleet-console/package.json");
const BACKUP_PATH = path.resolve(__dirname, "../runtime/fleet-console/.package.json.prepack-backup");
const TEMP_PATH = path.resolve(__dirname, "../runtime/fleet-console/.package.json.prepack-tmp");
const EXTERNAL_DEP_NAMES = ["node-pty", "ws"];

const action = process.argv[2];

if (action === "prepack") {
  prepack();
} else if (action === "postpack") {
  postpack();
} else {
  throw new Error("Usage: pack-fleet-console-manifest.mjs <prepack|postpack>");
}

function prepack() {
  if (existsSync(BACKUP_PATH)) {
    postpack();
  }
  const original = readFileSync(PKG_PATH, "utf8");
  let backupCreated = false;
  try {
    const pkg = JSON.parse(original);
    const externalDeps = {};
    for (const name of EXTERNAL_DEP_NAMES) {
      const range = pkg.dependencies?.[name];
      if (!range) {
        throw new Error(`external dependency ${name} not found in ${PKG_PATH}`);
      }
      externalDeps[name] = range;
    }

    atomicWrite(BACKUP_PATH, original);
    backupCreated = true;
    delete pkg.private;
    pkg.dependencies = externalDeps;
    pkg.scripts = { postinstall: "node postinstall.mjs" };
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

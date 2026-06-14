import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES_DIR = path.join(PKG_ROOT, "node_modules");

if (process.platform === "darwin" && existsSync(NODE_MODULES_DIR)) {
  for (const filePath of findSpawnHelpers(NODE_MODULES_DIR)) {
    const mode = statSync(filePath).mode;
    chmodSync(filePath, mode | 0o755);
  }
}

function findSpawnHelpers(dir) {
  const matches = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findSpawnHelpers(entryPath));
    } else if (entry.isFile() && isNodePtySpawnHelper(entryPath)) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function isNodePtySpawnHelper(filePath) {
  const segments = filePath.split(path.sep);
  return (
    segments.at(-1) === "spawn-helper" &&
    segments.at(-3) === "prebuilds" &&
    segments.at(-2)?.startsWith("darwin-") === true &&
    segments.includes("node-pty")
  );
}

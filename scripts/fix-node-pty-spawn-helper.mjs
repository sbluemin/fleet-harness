import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const NODE_MODULES_DIR = path.resolve("node_modules");
const SPAWN_HELPER_SEGMENTS = ["prebuilds", "spawn-helper"];

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
      continue;
    }

    if (entry.isFile() && isNodePtySpawnHelper(entryPath)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

function isNodePtySpawnHelper(filePath) {
  const normalized = filePath.split(path.sep);
  const fileName = normalized.at(-1);
  const prebuildsDir = normalized.at(-3);
  const platformDir = normalized.at(-2);

  return (
    fileName === SPAWN_HELPER_SEGMENTS[1] &&
    prebuildsDir === SPAWN_HELPER_SEGMENTS[0] &&
    platformDir?.startsWith("darwin-") === true &&
    normalized.includes("node-pty")
  );
}

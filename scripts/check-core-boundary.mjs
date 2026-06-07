import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const packagesDir = path.resolve("packages");
const violations = [];

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("core-")) continue;
  const manifestPath = path.join(packagesDir, entry.name, "package.json");
  const manifest = readFileSync(manifestPath, "utf8");
  if (manifest.includes('"@dotobokuri/fleet-')) {
    violations.push(path.relative(process.cwd(), manifestPath));
  }
}

if (violations.length > 0) {
  console.error("core package manifests must not depend on @dotobokuri/fleet-* packages:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

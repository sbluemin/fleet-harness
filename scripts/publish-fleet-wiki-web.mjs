import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, "../packages/fleet-wiki-web/package.json");
const PKG_DIR = path.dirname(PKG_PATH);

const EXTERNAL_DEPS = {
  typebox: "^1.1.24",
};

const args = process.argv.slice(2);
const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "beta";
const version = args.find((a) => a.startsWith("--version="))?.split("=")[1];
const dryRun = args.includes("--dry-run");

const original = readFileSync(PKG_PATH, "utf8");

execSync("pnpm build", { cwd: PKG_DIR, stdio: "inherit" });

try {
  const pkg = JSON.parse(original);

  delete pkg.private;
  pkg.dependencies = EXTERNAL_DEPS;
  if (version) pkg.version = version;

  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

  const publishCmd = [
    "npm publish",
    `--tag ${tag}`,
    "--access public",
    dryRun ? "--dry-run" : "",
  ]
    .filter(Boolean)
    .join(" ");

  execSync(publishCmd, { cwd: PKG_DIR, stdio: "inherit" });
} finally {
  writeFileSync(PKG_PATH, original);
}

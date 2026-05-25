import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, "../runtime/fleet-cli/package.json");
const PKG_DIR = path.dirname(PKG_PATH);

const args = process.argv.slice(2);
const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "beta";
const version = args.find((a) => a.startsWith("--version="))?.split("=")[1];
const wikiWebVersion = args.find((a) => a.startsWith("--wiki-web-version="))?.split("=")[1];
const dryRun = args.includes("--dry-run");

const isPrerelease = version && version.includes("-");
const wikiWebRange = wikiWebVersion
  ?? (isPrerelease ? version : "^0.21.0");

const EXTERNAL_DEPS = {
  "@clack/prompts": "1.4.0",
  "@dotobokuri/fleet-wiki-ui": wikiWebRange,
  "@xterm/headless": "^5.5.0",
  "node-pty": "^1.0.0",
};

const original = readFileSync(PKG_PATH, "utf8");
const pkgName = JSON.parse(original).name;
const targetVersion = version ?? JSON.parse(original).version;

try {
  execSync(`npm view ${pkgName}@${targetVersion} version`, { stdio: "pipe" });
  console.log(`${pkgName}@${targetVersion} already published. Updating dist-tag to ${tag}.`);
  execSync(`npm dist-tag add ${pkgName}@${targetVersion} ${tag}`, { stdio: "inherit" });
  process.exit(0);
} catch {}

execSync("pnpm build:bundle", { cwd: PKG_DIR, stdio: "inherit" });

try {
  const pkg = JSON.parse(original);

  delete pkg.private;
  pkg.dependencies = EXTERNAL_DEPS;
  pkg.scripts = { postinstall: "node postinstall.mjs" };
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

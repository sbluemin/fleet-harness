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
const dryRun = args.includes("--dry-run");

// 배포 산출물에서 external로 유지할 패키지 이름 목록 — 버전은 원본 package.json에서 읽는다.
const EXTERNAL_DEP_NAMES = ["@clack/prompts", "@xterm/headless", "node-pty"];

const original = readFileSync(PKG_PATH, "utf8");
const originalPkg = JSON.parse(original);
const pkgName = originalPkg.name;
const targetVersion = version ?? originalPkg.version;

const EXTERNAL_DEPS = {};
for (const name of EXTERNAL_DEP_NAMES) {
  const range = originalPkg.dependencies?.[name];
  if (!range) {
    console.error(`external dependency ${name} not found in ${PKG_PATH}`);
    process.exit(1);
  }
  EXTERNAL_DEPS[name] = range;
}

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

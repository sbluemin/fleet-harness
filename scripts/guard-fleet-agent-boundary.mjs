import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const packageRoot = path.join(root, "runtime", "fleet-cli");
const scanRoots = ["src", "package.json", "AGENTS.md", "README.md", "CLAUDE.md"].map((entry) => path.join(packageRoot, entry));
const forbidden = [
  /@dotobokuri\/fleet-harness/,
  /@dotobokuri\/fleet-ai/,
  /@dotobokuri\/fleet-coding-agent/,
  /@dotobokuri\/fleet-(?:ai|cli|coding-agent)["']\s*:\s*["']workspace:\*/,
];
const allowedDocPhrases = [
  "permanently forbidden",
  "forbidden dependencies",
  "Forbidden Workspace Dependencies",
  "must not depend",
  "permanently exclude",
  "fails on forbidden imports",
  "generally forbidden, with the sole exception",
];

const findings = [];
const oldInputPathReference =
  /(?:src\/input|from\s+["'][^"']*input\/modes[^"']*["'])/;

for (const file of listFiles(scanRoots)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!forbidden.some((pattern) => pattern.test(line))) {
      return;
    }

    if ((file.endsWith("AGENTS.md") || file.endsWith("README.md") || file.endsWith("CLAUDE.md")) && allowedDocPhrases.some((phrase) => line.includes(phrase))) {
      return;
    }

    findings.push(`${path.relative(root, file)}:${index + 1}: ${line}`);
  });

  lines.forEach((line, index) => {
    if (oldInputPathReference.test(line)) {
      findings.push(`${path.relative(root, file)}:${index + 1}: old src/input path is forbidden in V4: ${line}`);
    }

  });

}

if (findings.length > 0) {
  process.stderr.write(`Fleet Agent boundary guard failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}

function listFiles(entries) {
  const files = [];
  for (const entry of entries) {
    let stat;
    try {
      stat = statSync(entry);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) {
        files.push(...listFiles([path.join(entry, child)]));
      }
    } else {
      files.push(entry);
    }
  }
  return files;
}

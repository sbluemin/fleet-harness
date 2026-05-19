import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const packageRoot = path.join(root, "packages", "fleet-dedicated-harness");
const scanRoots = ["src", "package.json", "AGENTS.md", "README.md"].map((entry) => path.join(packageRoot, entry));
const forbidden = [
  /@sbluemin\/fleet-harness/,
  /@sbluemin\/fleet-tui/,
  /@sbluemin\/fleet-ai/,
  /@sbluemin\/fleet-agent/,
  /@sbluemin\/fleet-coding-agent/,
  /engines\//,
  /workspace:\*.*@sbluemin\/fleet-(?:ai|agent|coding-agent|tui)/,
];
const allowedDocPhrases = [
  "permanently forbidden",
  "forbidden dependencies",
  "must not depend",
  "permanently exclude",
  "fails on forbidden imports",
];

const findings = [];
const forbiddenFleetPtyInternalImport =
  /from\s+["'][^"']*tui\/pty\/fleet\/(?!api\.js)(?:region-stack|overlay-manager|sections|types|component|frame|keys|local-ui|theme)[^"']*["']/;

for (const file of listFiles(scanRoots)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!forbidden.some((pattern) => pattern.test(line))) {
      return;
    }

    if ((file.endsWith("AGENTS.md") || file.endsWith("README.md")) && allowedDocPhrases.some((phrase) => line.includes(phrase))) {
      return;
    }

    findings.push(`${path.relative(root, file)}:${index + 1}: ${line}`);
  });

  if (file.includes(`${path.sep}src${path.sep}`) && !file.includes(`${path.sep}src${path.sep}tui${path.sep}pty${path.sep}fleet${path.sep}`)) {
    lines.forEach((line, index) => {
      if (forbiddenFleetPtyInternalImport.test(line)) {
        findings.push(`${path.relative(root, file)}:${index + 1}: external Fleet PTY consumer must import tui/pty/fleet/api.js only: ${line}`);
      }
    });
  }
}

if (findings.length > 0) {
  process.stderr.write(`Dedicated Harness boundary guard failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}

function listFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const stat = statSync(entry);
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

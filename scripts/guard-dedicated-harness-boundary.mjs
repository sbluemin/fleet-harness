import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const packageRoot = path.join(root, "packages", "fleet-dedicated-harness");
const scanRoots = ["src", "package.json", "AGENTS.md", "README.md", "CLAUDE.md"].map((entry) => path.join(packageRoot, entry));
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
const oldInputPathReference =
  /(?:src\/input|from\s+["'][^"']*(?:\.\/input|\.\.\/input|input\/modes)[^"']*["'])/;
const tuiImport = /from\s+["']([^"']*tui\/[^"']*)["']/;
const allowedHostTuiImport = /tui\/(?:pty\/fleet\/api|input\/[^"']+)\.js$/;

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

  if (file.includes(`${path.sep}src${path.sep}`) && !file.includes(`${path.sep}src${path.sep}tui${path.sep}pty${path.sep}fleet${path.sep}`)) {
    lines.forEach((line, index) => {
      if (forbiddenFleetPtyInternalImport.test(line)) {
        findings.push(`${path.relative(root, file)}:${index + 1}: external Fleet PTY consumer must import tui/pty/fleet/api.js only: ${line}`);
      }
    });
  }

  lines.forEach((line, index) => {
    if (oldInputPathReference.test(line)) {
      findings.push(`${path.relative(root, file)}:${index + 1}: old src/input path is forbidden in V3: ${line}`);
    }
  });

  if (isHostControlsOrSections(file)) {
    lines.forEach((line, index) => {
      const match = tuiImport.exec(line);
      if (match && !allowedHostTuiImport.test(match[1])) {
        findings.push(`${path.relative(root, file)}:${index + 1}: controls/sections may import only tui/pty/fleet/api.js or tui/input/*.js: ${line}`);
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

function isHostControlsOrSections(file) {
  return file.includes(`${path.sep}src${path.sep}controls${path.sep}`)
    || file.includes(`${path.sep}src${path.sep}sections${path.sep}`);
}

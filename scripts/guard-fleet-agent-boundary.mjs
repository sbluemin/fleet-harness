import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptDir);
const packageRoot = path.join(root, "runtime", "fleet-cli");
const fleetTuiRoot = path.join(root, "packages", "fleet-tui");
const scanRoots = ["src", "package.json", "AGENTS.md", "README.md", "CLAUDE.md"].map((entry) => path.join(packageRoot, entry));
const fleetTuiScanRoots = ["src", "package.json", "AGENTS.md", "README.md", "CLAUDE.md"].map((entry) => path.join(fleetTuiRoot, entry));
const forbidden = [
  /@dotobokuri\/fleet-harness/,
  /@dotobokuri\/fleet-ai/,
  /@dotobokuri\/fleet-coding-agent/,
  /workspace:\*.*@dotobokuri\/fleet-(?:ai|cli|coding-agent)/,
];
const fleetTuiForbidden = [
  /@dotobokuri\/fleet-carriers/,
  /@dotobokuri\/fleet-harness/,
  /@dotobokuri\/fleet-cli/,
  /@dotobokuri\/fleet-wiki/,
  /@dotobokuri\/fleet-wiki-ui/,
  /@dotobokuri\/fleet-ai/,
  /@dotobokuri\/fleet-coding-agent/,
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
const forbiddenFleetTuiDeepImport =
  /from\s+["']@dotobokuri\/fleet-tui\/(?!(?:core|components|layout|primitives|style)["'])(?:src|dist|[^"']+)["']/;
const forbiddenFleetTuiSrcDistImport = /from\s+["']@dotobokuri\/fleet-tui\/(?:src|dist)(?:\/|["'])/;
const oldInputPathReference =
  /(?:src\/input|from\s+["'][^"']*input\/modes[^"']*["'])/;
const oldLocalTuiImport = /from\s+["'][^"']*\.{1,2}\/tui\/[^"']*["']/;
const oldSrcTuiReference = /src\/tui/;
const fleetTuiImport = /from\s+["'](@dotobokuri\/fleet-tui(?:\/[^"']+)?)["']/;
const allowedDomainFleetTuiImport = /^@dotobokuri\/fleet-tui\/(?:core|components|layout|primitives|style)$/;

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

    if (oldLocalTuiImport.test(line)) {
      findings.push(`${path.relative(root, file)}:${index + 1}: local src/tui imports are forbidden in V4: ${line}`);
    }

    if (file.includes(`${path.sep}src${path.sep}`) && (forbiddenFleetTuiDeepImport.test(line) || forbiddenFleetTuiSrcDistImport.test(line))) {
      findings.push(`${path.relative(root, file)}:${index + 1}: @dotobokuri/fleet-tui deep imports are forbidden: ${line}`);
    }
  });

  if (isDomainConsumer(file)) {
    lines.forEach((line, index) => {
      const match = fleetTuiImport.exec(line);
      if (match && !allowedDomainFleetTuiImport.test(match[1])) {
        findings.push(`${path.relative(root, file)}:${index + 1}: controls/sections/carrier-status may import only primitive @dotobokuri/fleet-tui subpaths: ${line}`);
      }
    });
  }

  if ((file.endsWith("AGENTS.md") || file.endsWith("README.md") || file.endsWith("CLAUDE.md")) && oldSrcTuiReference.test(text)) {
    findings.push(`${path.relative(root, file)}: old src/tui documentation reference is forbidden in V4`);
  }
}

for (const file of listFiles(fleetTuiScanRoots)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!fleetTuiForbidden.some((pattern) => pattern.test(line))) {
      return;
    }

    if ((file.endsWith("AGENTS.md") || file.endsWith("README.md") || file.endsWith("CLAUDE.md")) && allowedDocPhrases.some((phrase) => line.includes(phrase))) {
      return;
    }

    findings.push(`${path.relative(root, file)}:${index + 1}: ${line}`);
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

function isDomainConsumer(file) {
  return file.includes(`${path.sep}src${path.sep}controls${path.sep}`)
    || file.includes(`${path.sep}src${path.sep}sections${path.sep}`)
    || file.includes(`${path.sep}src${path.sep}carrier-status${path.sep}`);
}

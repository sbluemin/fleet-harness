import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 스크립트 위치 기준으로 repo root를 해석한다(cwd 비의존).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const protocolGatePath = path.join(repoRoot, "packages", "fleet-admiral", "src", "protocols", "fleet-action.ts");
const skillRoot = path.join(repoRoot, "runtime", "fleet-cli", "assets", "skills");
const findings = [];

checkProtocolModes();
checkDownwardGuardDuplication();
checkReportTokens();

if (findings.length > 0) {
  process.stderr.write(`Protocol sync check failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}

function checkProtocolModes() {
  const gateText = readFileSync(protocolGatePath, "utf8");
  const modeGateSection = gateText.split("## Mode Gate")[1]?.split("If operational mode is ambiguous")[0] ?? "";
  const gateModes = unique([...modeGateSection.matchAll(/fleet-protocol-([a-z-]+)/g)].map((match) => match[1])).sort();
  const skillModes = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("fleet-protocol-"))
    .map((entry) => entry.name.replace(/^fleet-protocol-/, ""))
    .sort();

  const gateOnly = gateModes.filter((mode) => !skillModes.includes(mode));
  const skillOnly = skillModes.filter((mode) => !gateModes.includes(mode));
  if (gateOnly.length > 0) {
    findings.push(`${relative(protocolGatePath)}: gate modes missing skill directories: ${gateOnly.join(", ")}`);
  }
  if (skillOnly.length > 0) {
    findings.push(`${relative(skillRoot)}: skill directories missing gate modes: ${skillOnly.join(", ")}`);
  }
}

function checkDownwardGuardDuplication() {
  const guardPhrases = downwardGuardTriggerPhrases();
  const staleGuardPatterns = [
    /no structural, API, doctrine, multi-module, or multi-carrier signal/i,
    /affirm bounded single-owner scope/i,
    /if a full boundary map, risk review, or parallel ownership emerges/i,
    /no structural/i,
    /downward-guard:/i,
  ];

  for (const file of protocolSkillFiles()) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const staleMatch =
        /Downward-guard|downward-guard|structural|API|doctrine|multi-module|multi-carrier|boundary map|risk review|parallel ownership/i.test(
          line,
        ) && staleGuardPatterns.some((pattern) => pattern.test(line));
      const copiedGatePhrase = guardPhrases.find((phrase) => normalizedLineIncludesPhrase(line, phrase));
      if (!staleMatch && copiedGatePhrase === undefined) {
        return;
      }
      if (copiedGatePhrase !== undefined && isAllowedGuardPhraseContext(file, line, index)) {
        return;
      }
      findings.push(`${relative(file)}:${index + 1}: duplicated Downward Guard enumeration: ${line.trim()}`);
    });
  }
}

function checkReportTokens() {
  const tokenPattern = /→ report\s+`([^`]+)`/;
  const validToken = /^[a-z]+: .+$/;

  for (const file of protocolSkillFiles()) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes("→ report")) {
        return;
      }
      const match = line.match(tokenPattern);
      if (match === null) {
        findings.push(`${relative(file)}:${index + 1}: report token must be backtick-wrapped: ${line.trim()}`);
        return;
      }
      const token = match[1];
      if (!validToken.test(token)) {
        findings.push(`${relative(file)}:${index + 1}: invalid report token grammar: ${token}`);
      }
    });
  }
}

function downwardGuardTriggerPhrases() {
  const gateText = readFileSync(protocolGatePath, "utf8");
  const guardSection = gateText.split("## Downward Guard")[1]?.split("## Mode Mapping")[0] ?? "";
  const phraseSources = [
    guardSection.match(/when (.+?) are in scope/)?.[1],
    guardSection.match(/unless (.+?) makes/)?.[1],
  ].filter(Boolean);

  return unique(
    phraseSources.flatMap((source) =>
      source
        .replace(/\bor\b/g, ",")
        .split(",")
        .map((phrase) => normalizeGuardPhrase(phrase))
        .filter((phrase) => phrase.length > 0),
    ),
  );
}

function normalizedLineIncludesPhrase(line, phrase) {
  return normalizeGuardPhrase(line).includes(phrase);
}

function normalizeGuardPhrase(value) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/&/g, " and ")
    .replace(/[/()-]/g, " ")
    .replace(/\b(and|any|when|or|the|work|workstreams|in|scope|required|requires|required)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowedGuardPhraseContext(file, line, index) {
  const fileName = path.basename(path.dirname(file));
  const isFrontMatterDescription = index < 4 && /^description: /.test(line);
  const isEscalationCheck = /\*\*Escalation\*\*.*re-classify under multi-agent/.test(line);
  if (fileName === "fleet-protocol-high-risk") {
    return isFrontMatterDescription || /^Use this mode /.test(line) || isEscalationCheck;
  }
  if (fileName === "fleet-protocol-multi-agent") {
    return isFrontMatterDescription || /^Use this mode /.test(line);
  }
  return false;
}

function protocolSkillFiles() {
  return readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("fleet-protocol-"))
    .map((entry) => path.join(skillRoot, entry.name, "SKILL.md"))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

function relative(file) {
  return path.relative(repoRoot, file);
}

function unique(values) {
  return [...new Set(values)];
}

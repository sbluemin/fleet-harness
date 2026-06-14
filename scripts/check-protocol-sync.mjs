import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 스크립트 위치 기준으로 repo root를 해석한다(cwd 비의존).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const protocolGatePath = path.join(repoRoot, "packages", "fleet-admiral", "src", "protocols", "fleet-action.ts");
const skillRoot = path.join(repoRoot, "runtime", "fleet-cli", "assets", "skills");
// Protocol mode 스킬은 공통 접두사가 없으므로 명시적 집합으로 SSoT를 고정한다(gate ↔ skill 디렉토리 양방향 검증의 기대값).
const PROTOCOL_MODE_DIRS = ["protocol-baseline", "protocol-midline", "protocol-redline", "protocol-frontline"];
const findings = [];

checkProtocolModes();
checkDownwardGuardDuplication();
checkReportTokens();

if (findings.length > 0) {
  process.stderr.write(`Protocol sync check failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}

function checkProtocolModes() {
  const expected = [...PROTOCOL_MODE_DIRS].sort();
  const gateText = readFileSync(protocolGatePath, "utf8");
  const modeGateSection = gateText.split("## Mode Gate")[1]?.split("If operational mode is ambiguous")[0] ?? "";
  // gate 소스에서 mode 이름은 백틱 escaping(`${"`"}<mode>${"`"}`)으로 등장한다.
  const gateModes = expected.filter((mode) => modeGateSection.includes(backtickWrapped(mode)));
  const skillModes = readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROTOCOL_MODE_DIRS.includes(entry.name))
    .map((entry) => entry.name)
    .sort();

  const gateMissing = expected.filter((mode) => !gateModes.includes(mode));
  const skillMissing = expected.filter((mode) => !skillModes.includes(mode));
  if (gateMissing.length > 0) {
    findings.push(`${relative(protocolGatePath)}: Mode Gate missing expected protocol modes: ${gateMissing.join(", ")}`);
  }
  if (skillMissing.length > 0) {
    findings.push(`${relative(skillRoot)}: skill directories missing expected protocol modes: ${skillMissing.join(", ")}`);
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
  const isEscalationCheck = /\*\*Escalation\*\*.*re-classify under frontline/.test(line);
  if (fileName === "protocol-redline") {
    return isFrontMatterDescription || /^Use this mode /.test(line) || isEscalationCheck;
  }
  if (fileName === "protocol-frontline") {
    return isFrontMatterDescription || /^Use this mode /.test(line);
  }
  return false;
}

function protocolSkillFiles() {
  return readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROTOCOL_MODE_DIRS.includes(entry.name))
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

// gate TS 소스에서 mode 이름은 백틱 escaping 패턴 `${"`"}<mode>${"`"}` 으로 인라인된다.
function backtickWrapped(value) {
  return `\${"\`"}${value}\${"\`"}`;
}

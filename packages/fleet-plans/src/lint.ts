import type {
  PlanDiagnostic,
  PlanLane,
  PlanLintResult,
  PlanTask,
} from "./types.js";

const REQUIRED_HEADINGS = [
  "# Objective",
  "# File Ownership",
  "# Execution Topology",
  "# Waves",
  "# Dispatch Manifest",
  "# QA Gates",
  "# Acceptance Criteria",
  "# Documentation Updates",
  "# Final Review Loop",
] as const;

const REQUIRED_LANE_FIELDS = [
  "Exact write set",
  "Read dependencies",
  "Dependency/start condition",
  "Eligible concurrent lanes",
  "Integration gate",
  "Handoff",
  "Rollback unit",
  "Implementation summary",
  "Verification/static checks",
  "Escalation triggers",
] as const;

const WAVE_HEADING_PATTERN = /^## Wave ([1-9]\d*) — (.+)$/;
const LANE_HEADING_PATTERN = /^### Lane (W[1-9]\d*-[A-Z][A-Z0-9]*) — (.+)$/;
const TASK_PATTERN = /^\s+- \[([ xX])\] (W[1-9]\d*-[A-Z][A-Z0-9]*-T[1-9]\d*) — (.+)$/;
const MANIFEST_LANE_PATTERN = /^- Lane (W[1-9]\d*-[A-Z][A-Z0-9]*) — /;
const OWNERSHIP_LANE_PATTERN = /^- (W[1-9]\d*-[A-Z][A-Z0-9]*)(?=\s|$)/;

interface MutableLane {
  dependencyStartConditions: string[];
  end: number;
  eligibleConcurrentLaneIds: string[];
  escalationTriggers: string[];
  handoff: string[];
  id: string;
  integrationGate: string[];
  name: string;
  readDependencies: string[];
  rollbackUnit: string[];
  start: number;
  taskIds: string[];
  verificationStaticChecks: string[];
  waveId: string;
  writeSet: string[];
}

interface LaneStart {
  id: string;
  name: string;
  start: number;
  waveId: string;
}

export interface PlanExecutionLane {
  readonly dependencyStartConditions: readonly string[];
  readonly eligibleConcurrentLaneIds: readonly string[];
  readonly escalationTriggers: readonly string[];
  readonly handoff: readonly string[];
  readonly id: string;
  readonly integrationGate: readonly string[];
  readonly name: string;
  readonly readDependencies: readonly string[];
  readonly rollbackUnit: readonly string[];
  readonly verificationStaticChecks: readonly string[];
  readonly waveId: string;
  readonly writeSet: readonly string[];
}

export interface PlanExecutionSections {
  readonly acceptanceCriteria: string;
  readonly documentationUpdates: string;
  readonly executionTopology: string;
  readonly finalReviewLoop: string;
  readonly objective: string;
  readonly qaGates: string;
}

export interface PlanExecutionStructure {
  readonly lanes: readonly PlanExecutionLane[];
  readonly sections: PlanExecutionSections;
}

export function lintPlanMarkdown(markdown: string): PlanLintResult {
  const lines = normalizeMarkdown(markdown).split("\n");
  const diagnostics: PlanDiagnostic[] = [];
  const headingLines = validateRequiredHeadings(lines, diagnostics);
  const lanes = parseLanes(lines, headingLines, diagnostics);
  const tasks = parseTasks(lines, lanes, diagnostics);
  validateTopology(sectionBodyLines(lines, headingLines, "# Execution Topology"), lanes, diagnostics);
  validateManifest(sectionBodyLines(lines, headingLines, "# Dispatch Manifest"), lanes, diagnostics);
  validateOwnership(sectionBodyLines(lines, headingLines, "# File Ownership"), lanes, diagnostics);
  validateLaneConcurrency(lanes, diagnostics);
  validateSectionBodies(lines, headingLines, diagnostics);

  return {
    diagnostics,
    lanes: lanes.map(toPlanLane),
    tasks,
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
  };
}

export function extractPlanExecutionStructure(markdown: string): PlanExecutionStructure {
  const lines = normalizeMarkdown(markdown).split("\n");
  const diagnostics: PlanDiagnostic[] = [];
  const headingLines = validateRequiredHeadings(lines, diagnostics);
  return {
    lanes: parseLanes(lines, headingLines, diagnostics).map(toPlanExecutionLane),
    sections: parsePlanSections(lines, headingLines),
  };
}

export function normalizePlanMarkdown(markdown: string): string {
  return `${normalizeMarkdown(markdown).replace(/\n+$/u, "")}\n`;
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function validateRequiredHeadings(lines: readonly string[], diagnostics: PlanDiagnostic[]): Map<string, number> {
  const headingLines = new Map<string, number>();
  let previousIndex = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const indexes = indexesOf(lines, heading);
    if (indexes.length === 0) {
      addDiagnostic(diagnostics, "MISSING_HEADING", `Required heading is missing: ${heading}`);
      continue;
    }
    if (indexes.length > 1) {
      addDiagnostic(diagnostics, "DUPLICATE_HEADING", `Required heading appears more than once: ${heading}`, indexes[1]);
    }
    const index = indexes[0]!;
    headingLines.set(heading, index);
    if (index <= previousIndex) {
      addDiagnostic(diagnostics, "HEADING_ORDER", `Required heading is out of order: ${heading}`, index);
    }
    previousIndex = Math.max(previousIndex, index);
  }
  const finalReviewLine = headingLines.get("# Final Review Loop");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith("# ") || REQUIRED_HEADINGS.includes(line as (typeof REQUIRED_HEADINGS)[number])) continue;
    if (finalReviewLine === undefined || index < finalReviewLine) {
      addDiagnostic(diagnostics, "UNEXPECTED_HEADING", `Extra top-level headings are allowed only after # Final Review Loop: ${line}`, index);
    }
  }
  return headingLines;
}

function validateSectionBodies(
  lines: readonly string[],
  headingLines: ReadonlyMap<string, number>,
  diagnostics: PlanDiagnostic[],
): void {
  for (let index = 0; index < REQUIRED_HEADINGS.length; index++) {
    const heading = REQUIRED_HEADINGS[index]!;
    const start = headingLines.get(heading);
    if (start === undefined) continue;
    const hasBody = sectionBodyLines(lines, headingLines, heading)
      .some((line) => line.trim().length > 0 && !line.trim().startsWith("<!--"));
    if (!hasBody) {
      addDiagnostic(diagnostics, "EMPTY_SECTION", `Required section is empty: ${heading}`, start);
    }
  }
}

function validateTopology(
  lines: readonly string[],
  lanes: readonly MutableLane[],
  diagnostics: PlanDiagnostic[],
): void {
  const modes = lines
    .map((line, index) => ({ index, match: /^- Execution mode: (Sequential|Parallel)$/.exec(line) }))
    .filter((entry): entry is { index: number; match: RegExpExecArray } => entry.match !== null);
  if (modes.length !== 1) {
    addDiagnostic(diagnostics, "EXECUTION_MODE", "Execution Topology must declare exactly one Sequential or Parallel execution mode");
  }
  const sharedResources = lines.filter((line) => line.startsWith("- Shared mutable resources:"));
  if (sharedResources.length !== 1 || sharedResources[0] === "- Shared mutable resources:") {
    addDiagnostic(diagnostics, "SHARED_RESOURCES", "Execution Topology must declare exactly one non-empty shared mutable resources field");
  }
  const mode = modes.length === 1 ? modes[0]!.match[1] : undefined;
  const concurrencyCount = lanes.reduce((count, lane) => count + lane.eligibleConcurrentLaneIds.length, 0);
  if (mode === "Sequential" && concurrencyCount > 0) {
    addDiagnostic(diagnostics, "SEQUENTIAL_CONCURRENCY", "Sequential execution cannot declare eligible concurrent lanes");
  }
  if (mode === "Parallel" && concurrencyCount === 0) {
    addDiagnostic(diagnostics, "PARALLEL_WITHOUT_CONCURRENCY", "Parallel execution must declare at least one reciprocal concurrent Lane pair");
  }
}

function parseLanes(
  lines: readonly string[],
  headingLines: ReadonlyMap<string, number>,
  diagnostics: PlanDiagnostic[],
): MutableLane[] {
  const wavesRange = sectionBodyRange(lines, headingLines, "# Waves");
  const waves = new Map<string, number>();
  const laneStarts: LaneStart[] = [];
  let currentWaveId: string | undefined;

  for (let index = wavesRange.start; index < wavesRange.end; index++) {
    const waveMatch = WAVE_HEADING_PATTERN.exec(lines[index]!);
    if (waveMatch) {
      currentWaveId = `W${waveMatch[1]}`;
      if (waves.has(currentWaveId)) {
        addDiagnostic(diagnostics, "DUPLICATE_WAVE", `Duplicate wave id: ${currentWaveId}`, index);
      }
      if (Number(waveMatch[1]) !== waves.size + 1) {
        addDiagnostic(diagnostics, "WAVE_SEQUENCE", `Waves must be numbered contiguously from 1; found ${currentWaveId}`, index);
      }
      waves.set(currentWaveId, index);
      continue;
    }
    const laneMatch = LANE_HEADING_PATTERN.exec(lines[index]!);
    if (!laneMatch) continue;
    const laneId = laneMatch[1]!;
    if (!currentWaveId || !laneId.startsWith(`${currentWaveId}-`)) {
      addDiagnostic(diagnostics, "LANE_WAVE_MISMATCH", `Lane ${laneId} is not under its matching wave`, index);
    }
    if (laneStarts.some((lane) => lane.id === laneId)) {
      addDiagnostic(diagnostics, "DUPLICATE_LANE", `Duplicate lane id: ${laneId}`, index);
    }
    laneStarts.push({
      id: laneId,
      name: laneMatch[2]!.trim(),
      start: index,
      waveId: currentWaveId ?? laneId.split("-")[0]!,
    });
  }

  if (laneStarts.length === 0) {
    addDiagnostic(diagnostics, "MISSING_LANES", "The Waves section must contain at least one Lane");
  }

  return laneStarts.map((lane, index) => {
    const end = laneStarts[index + 1]?.start ?? wavesRange.end;
    const body = lines.slice(lane.start + 1, end);
    for (const field of REQUIRED_LANE_FIELDS) {
      const matches = body.filter((line) => line.startsWith(`- ${field}:`));
      if (matches.length === 0) {
        addDiagnostic(diagnostics, "MISSING_LANE_FIELD", `Lane ${lane.id} is missing field: ${field}`, lane.start);
      } else if (matches.length > 1) {
        addDiagnostic(diagnostics, "DUPLICATE_LANE_FIELD", `Lane ${lane.id} repeats field: ${field}`, lane.start);
      } else if (parseFieldValues(body, field).length === 0) {
        addDiagnostic(diagnostics, "EMPTY_LANE_FIELD", `Lane ${lane.id} has an empty field: ${field}`, lane.start);
      }
    }
    return {
      ...lane,
      dependencyStartConditions: parseFieldValues(body, "Dependency/start condition"),
      eligibleConcurrentLaneIds: parseFieldValues(body, "Eligible concurrent lanes")
        .flatMap(splitCommaValues)
        .filter((value) => value.toLowerCase() !== "none"),
      end,
      escalationTriggers: parseFieldValues(body, "Escalation triggers"),
      handoff: parseFieldValues(body, "Handoff"),
      integrationGate: parseFieldValues(body, "Integration gate"),
      readDependencies: parseFieldValues(body, "Read dependencies")
        .filter((value) => value !== "Not applicable"),
      rollbackUnit: parseFieldValues(body, "Rollback unit"),
      taskIds: [],
      verificationStaticChecks: parseFieldValues(body, "Verification/static checks"),
      writeSet: parseFieldValues(body, "Exact write set").filter((value) => value !== "Not applicable"),
    };
  });
}

function parseTasks(lines: readonly string[], lanes: MutableLane[], diagnostics: PlanDiagnostic[]): PlanTask[] {
  const tasks: PlanTask[] = [];
  const ids = new Set<string>();
  for (const lane of lanes) {
    const implementationRange = fieldBodyRange(lines, lane.start + 1, lane.end, "Implementation summary");
    for (let index = implementationRange.start; index < implementationRange.end; index++) {
      const match = TASK_PATTERN.exec(lines[index]!);
      if (!match) continue;
      const id = match[2]!;
      if (!id.startsWith(`${lane.id}-T`)) {
        addDiagnostic(diagnostics, "TASK_LANE_MISMATCH", `Task ${id} does not belong to lane ${lane.id}`, index);
      }
      if (ids.has(id)) {
        addDiagnostic(diagnostics, "DUPLICATE_TASK", `Duplicate task id: ${id}`, index);
      }
      ids.add(id);
      lane.taskIds.push(id);
      tasks.push({
        completed: match[1]!.toLowerCase() === "x",
        description: match[3]!.trim(),
        id,
        laneId: lane.id,
        line: index + 1,
        waveId: lane.waveId,
      });
    }
    if (lane.taskIds.length < 3 || lane.taskIds.length > 7) {
      addDiagnostic(
        diagnostics,
        "TASK_COUNT",
        `Lane ${lane.id} must contain 3-7 task checkboxes; found ${lane.taskIds.length}`,
        lane.start,
      );
    }
    for (let index = 0; index < lane.taskIds.length; index++) {
      const expected = `${lane.id}-T${index + 1}`;
      if (lane.taskIds[index] !== expected) {
        addDiagnostic(diagnostics, "TASK_SEQUENCE", `Lane ${lane.id} tasks must be numbered contiguously from T1; expected ${expected}`);
      }
    }
  }
  return tasks;
}

function validateManifest(manifestLines: readonly string[], lanes: readonly MutableLane[], diagnostics: PlanDiagnostic[]): void {
  const manifestIds = new Set<string>();
  for (const line of manifestLines) {
    const match = MANIFEST_LANE_PATTERN.exec(line);
    if (!match) continue;
    manifestIds.add(match[1]!);
  }
  for (const lane of lanes) {
    if (!manifestIds.has(lane.id)) {
      addDiagnostic(diagnostics, "MANIFEST_MISSING_LANE", `Dispatch Manifest is missing lane ${lane.id}`);
    }
  }
  for (const id of manifestIds) {
    if (!lanes.some((lane) => lane.id === id)) {
      addDiagnostic(diagnostics, "MANIFEST_UNKNOWN_LANE", `Dispatch Manifest references unknown lane ${id}`);
    }
  }
  const policy = "- Full-plan Ohio invocation: unavailable; dispatch explicit same-Lane TaskRefs only";
  if (manifestLines.filter((line) => line === policy).length !== 1) {
    addDiagnostic(diagnostics, "FULL_PLAN_POLICY", `Dispatch Manifest must contain exactly: ${policy}`);
  }
}

function validateOwnership(ownershipLines: readonly string[], lanes: readonly MutableLane[], diagnostics: PlanDiagnostic[]): void {
  const ownershipIds = new Set(ownershipLines.flatMap((line) => {
    const match = OWNERSHIP_LANE_PATTERN.exec(line);
    return match ? [match[1]!] : [];
  }));
  for (const lane of lanes) {
    if (!ownershipIds.has(lane.id)) {
      addDiagnostic(diagnostics, "OWNERSHIP_MISSING_LANE", `File Ownership is missing lane ${lane.id}`);
    }
  }
}

function validateLaneConcurrency(lanes: readonly MutableLane[], diagnostics: PlanDiagnostic[]): void {
  for (const lane of lanes) {
    for (const concurrentId of lane.eligibleConcurrentLaneIds) {
      const peer = lanes.find((candidate) => candidate.id === concurrentId);
      if (!peer) {
        addDiagnostic(diagnostics, "UNKNOWN_CONCURRENT_LANE", `Lane ${lane.id} references unknown concurrent lane ${concurrentId}`);
        continue;
      }
      if (!peer.eligibleConcurrentLaneIds.includes(lane.id)) {
        addDiagnostic(diagnostics, "ASYMMETRIC_CONCURRENCY", `Concurrent lane declaration must be reciprocal: ${lane.id} and ${peer.id}`);
      }
      const overlaps = findWriteSetOverlaps(lane.writeSet, peer.writeSet);
      if (overlaps.length > 0) {
        addDiagnostic(
          diagnostics,
          "WRITE_SET_OVERLAP",
          `Concurrent lanes ${lane.id} and ${peer.id} overlap: ${overlaps.join(", ")}`,
        );
      }
    }
  }
}

function toPlanLane(lane: MutableLane): PlanLane {
  return {
    id: lane.id,
    name: lane.name,
    taskIds: lane.taskIds,
    waveId: lane.waveId,
    writeSet: lane.writeSet,
  };
}

function toPlanExecutionLane(lane: MutableLane): PlanExecutionLane {
  return {
    dependencyStartConditions: lane.dependencyStartConditions,
    eligibleConcurrentLaneIds: lane.eligibleConcurrentLaneIds,
    escalationTriggers: lane.escalationTriggers,
    handoff: lane.handoff,
    id: lane.id,
    integrationGate: lane.integrationGate,
    name: lane.name,
    readDependencies: lane.readDependencies,
    rollbackUnit: lane.rollbackUnit,
    verificationStaticChecks: lane.verificationStaticChecks,
    waveId: lane.waveId,
    writeSet: lane.writeSet,
  };
}

function parsePlanSections(
  lines: readonly string[],
  headingLines: ReadonlyMap<string, number>,
): PlanExecutionSections {
  return {
    acceptanceCriteria: sectionBody(lines, headingLines, "# Acceptance Criteria"),
    documentationUpdates: sectionBody(lines, headingLines, "# Documentation Updates"),
    executionTopology: sectionBody(lines, headingLines, "# Execution Topology"),
    finalReviewLoop: sectionBody(lines, headingLines, "# Final Review Loop"),
    objective: sectionBody(lines, headingLines, "# Objective"),
    qaGates: sectionBody(lines, headingLines, "# QA Gates"),
  };
}

function sectionBody(
  lines: readonly string[],
  headingLines: ReadonlyMap<string, number>,
  heading: (typeof REQUIRED_HEADINGS)[number],
): string {
  return sectionBodyLines(lines, headingLines, heading).join("\n").trim();
}

function sectionBodyLines(
  lines: readonly string[],
  headingLines: ReadonlyMap<string, number>,
  heading: (typeof REQUIRED_HEADINGS)[number],
): readonly string[] {
  const range = sectionBodyRange(lines, headingLines, heading);
  return lines.slice(range.start, range.end);
}

function sectionBodyRange(
  lines: readonly string[],
  headingLines: ReadonlyMap<string, number>,
  heading: (typeof REQUIRED_HEADINGS)[number],
): { readonly end: number; readonly start: number } {
  const start = headingLines.get(heading);
  if (start === undefined) return { end: lines.length, start: lines.length };
  const headingIndex = REQUIRED_HEADINGS.indexOf(heading);
  const laterStarts = REQUIRED_HEADINGS.slice(headingIndex + 1)
    .map((candidate) => headingLines.get(candidate))
    .filter((candidate): candidate is number => candidate !== undefined && candidate > start);
  const end = laterStarts.length > 0
    ? Math.min(...laterStarts)
    : findNextTopLevelHeading(lines, start + 1);
  return { end, start: start + 1 };
}

function findWriteSetOverlaps(left: readonly string[], right: readonly string[]): string[] {
  const overlaps = new Set<string>();
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (writePatternsOverlap(leftPath, rightPath)) {
        overlaps.add(leftPath === rightPath ? leftPath : `${leftPath} <> ${rightPath}`);
      }
    }
  }
  return [...overlaps].sort();
}

function writePatternsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeWritePattern(left);
  const normalizedRight = normalizeWritePattern(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftPrefix = normalizedLeft.endsWith("/**") ? normalizedLeft.slice(0, -3) : undefined;
  const rightPrefix = normalizedRight.endsWith("/**") ? normalizedRight.slice(0, -3) : undefined;
  if (leftPrefix && (normalizedRight === leftPrefix || normalizedRight.startsWith(`${leftPrefix}/`))) return true;
  if (rightPrefix && (normalizedLeft === rightPrefix || normalizedLeft.startsWith(`${rightPrefix}/`))) return true;
  return false;
}

function normalizeWritePattern(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function parseFieldValues(lines: readonly string[], field: string): string[] {
  const index = lines.findIndex((line) => line.startsWith(`- ${field}:`));
  if (index < 0) return [];
  const inline = lines[index]!.slice(`- ${field}:`.length).trim();
  const values = inline ? [inline] : [];
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor]!;
    if (/^- [A-Za-z]/.test(line) || line.startsWith("#")) break;
    const child = /^\s+- (.+)$/.exec(line);
    if (child) values.push(child[1]!.trim());
  }
  return values;
}

function fieldBodyRange(
  lines: readonly string[],
  start: number,
  end: number,
  field: string,
): { readonly end: number; readonly start: number } {
  let fieldIndex = -1;
  for (let index = start; index < end; index++) {
    if (lines[index]!.startsWith(`- ${field}:`)) {
      fieldIndex = index;
      break;
    }
  }
  if (fieldIndex < 0) return { end, start: end };
  for (let index = fieldIndex + 1; index < end; index++) {
    const line = lines[index]!;
    if (/^- [A-Za-z]/.test(line) || line.startsWith("#")) {
      return { end: index, start: fieldIndex + 1 };
    }
  }
  return { end, start: fieldIndex + 1 };
}

function splitCommaValues(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function findNextTopLevelHeading(lines: readonly string[], start: number): number {
  for (let index = start; index < lines.length; index++) {
    if (lines[index]!.startsWith("# ")) return index;
  }
  return lines.length;
}

function indexesOf(lines: readonly string[], value: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === value) indexes.push(index);
  }
  return indexes;
}

function addDiagnostic(
  diagnostics: PlanDiagnostic[],
  code: string,
  message: string,
  zeroBasedLine?: number,
): void {
  diagnostics.push({
    code,
    ...(zeroBasedLine === undefined ? {} : { line: zeroBasedLine + 1 }),
    message,
    severity: "error",
  });
}

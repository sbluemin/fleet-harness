export type PlanExecutionMode = "sequential" | "parallel" | null;

export interface PlanWave {
  readonly index: number;
  readonly heading: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export interface ParsedPlan {
  readonly title: string | null;
  readonly executionMode: PlanExecutionMode;
  readonly waves: readonly PlanWave[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

interface TaskCounts {
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

interface PlanLine {
  readonly text: string;
  readonly isFenced: boolean;
}

interface WaveStart {
  readonly index: number;
  readonly heading: string;
  readonly lineIndex: number;
}

const TITLE_PATTERN = /^#\s+(.+)$/;
// Execution Topology 섹션의 필드 불릿 — Kirov lane 템플릿(# Execution Topology / - Execution mode: Sequential | Parallel)
const EXECUTION_MODE_PATTERN = /^-\s*Execution mode:\s*(sequential|parallel)\b/i;
const WAVE_PATTERN = /^##\s+wave\s+(\d+)\b/i;
const SECTION_HEADING_PATTERN = /^#{1,2}\s/;
const CHECKBOX_PATTERN = /^\s*-\s*\[( |x|X)\]/;
const FENCE_PATTERN = /^\s*(```|~~~)/;
// Kirov 기본 템플릿의 h1은 문서 제목이 아니라 섹션 헤딩이다 — title로 채택하지 않고 파일명 폴백에 맡긴다.
const TEMPLATE_SECTION_TITLES = new Set([
  "objective",
  "file ownership",
  "waves",
  "qa gates",
  "acceptance criteria",
  "documentation updates",
  "final review loop",
]);

export function parsePlan(content: string): ParsedPlan {
  const lines = scanPlanLines(content.split(/\r?\n/));
  const title = findTitle(lines);
  const executionMode = findExecutionMode(lines);
  const waveStarts = findWaveStarts(lines);
  const waves = waveStarts.map(({ index, heading, lineIndex }, waveIndex) => {
    const nextWaveLineIndex = waveStarts[waveIndex + 1]?.lineIndex ?? lines.length;
    const endLineIndex = findSectionEnd(lines, lineIndex + 1, nextWaveLineIndex);
    const counts = countTasks(lines.slice(lineIndex + 1, endLineIndex));

    return { index, heading, ...counts };
  });

  return { title, executionMode, waves, ...countTasks(lines) };
}

function scanPlanLines(lines: readonly string[]): readonly PlanLine[] {
  let activeFence: "```" | "~~~" | null = null;

  return lines.map((text) => {
    const marker = FENCE_PATTERN.exec(text)?.[1] as "```" | "~~~" | undefined;
    if (activeFence !== null) {
      if (marker === activeFence) activeFence = null;
      return { text, isFenced: true };
    }
    if (marker !== undefined) {
      activeFence = marker;
      return { text, isFenced: true };
    }
    return { text, isFenced: false };
  });
}

function findTitle(lines: readonly PlanLine[]): string | null {
  for (const line of lines) {
    if (line.isFenced) continue;
    const match = TITLE_PATTERN.exec(line.text);
    if (!match?.[1]) continue;
    const heading = match[1].trim();
    if (TEMPLATE_SECTION_TITLES.has(heading.toLowerCase())) return null;
    return heading;
  }
  return null;
}

function findExecutionMode(lines: readonly PlanLine[]): PlanExecutionMode {
  for (const line of lines) {
    if (line.isFenced) continue;
    const match = EXECUTION_MODE_PATTERN.exec(line.text.trim());
    if (match?.[1]) return match[1].toLowerCase() as "sequential" | "parallel";
  }
  return null;
}

function findWaveStarts(lines: readonly PlanLine[]): WaveStart[] {
  const waves: WaveStart[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (line.isFenced) continue;
    const match = WAVE_PATTERN.exec(line.text);
    if (!match?.[1]) continue;
    waves.push({
      index: Number(match[1]),
      heading: line.text.replace(/^##\s+/, ""),
      lineIndex,
    });
  }

  return waves;
}

function findSectionEnd(lines: readonly PlanLine[], startLineIndex: number, maxLineIndex: number): number {
  for (let lineIndex = startLineIndex; lineIndex < maxLineIndex; lineIndex++) {
    const line = lines[lineIndex];
    if (!line?.isFenced && SECTION_HEADING_PATTERN.test(line?.text ?? "")) return lineIndex;
  }
  return maxLineIndex;
}

function countTasks(lines: readonly PlanLine[]): TaskCounts {
  let tasksDone = 0;
  let tasksTotal = 0;

  for (const line of lines) {
    if (line.isFenced) continue;
    const match = CHECKBOX_PATTERN.exec(line.text);
    if (!match) continue;
    tasksTotal++;
    if (match[1] === "x" || match[1] === "X") tasksDone++;
  }

  return { tasksDone, tasksTotal };
}

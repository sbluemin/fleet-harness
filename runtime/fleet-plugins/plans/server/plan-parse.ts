export interface PlanWave {
  readonly index: number;
  readonly heading: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export interface ParsedPlan {
  readonly title: string | null;
  readonly waves: readonly PlanWave[];
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

interface TaskCounts {
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

const TITLE_PATTERN = /^#\s+(.+)$/;
const WAVE_PATTERN = /^##\s+wave\s+(\d+)\b/i;
const SECTION_HEADING_PATTERN = /^#{1,2}\s/;
const CHECKBOX_PATTERN = /^\s*-\s*\[( |x|X)\]/;

export function parsePlan(content: string): ParsedPlan {
  const lines = content.split(/\r?\n/);
  const title = findTitle(lines);
  const waveStarts = findWaveStarts(lines);
  const waves = waveStarts.map(({ index, heading, lineIndex }, waveIndex) => {
    const nextWaveLineIndex = waveStarts[waveIndex + 1]?.lineIndex ?? lines.length;
    const endLineIndex = findSectionEnd(lines, lineIndex + 1, nextWaveLineIndex);
    const counts = countTasks(lines.slice(lineIndex + 1, endLineIndex));

    return { index, heading, ...counts };
  });

  return { title, waves, ...countTasks(lines) };
}

function findTitle(lines: readonly string[]): string | null {
  for (const line of lines) {
    const match = TITLE_PATTERN.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

function findWaveStarts(lines: readonly string[]): Array<{ index: number; heading: string; lineIndex: number }> {
  const waves: Array<{ index: number; heading: string; lineIndex: number }> = [];

  for (const [lineIndex, line] of lines.entries()) {
    const match = WAVE_PATTERN.exec(line);
    if (!match?.[1]) continue;
    waves.push({
      index: Number(match[1]),
      heading: line.replace(/^##\s+/, ""),
      lineIndex,
    });
  }

  return waves;
}

function findSectionEnd(lines: readonly string[], startLineIndex: number, maxLineIndex: number): number {
  for (let lineIndex = startLineIndex; lineIndex < maxLineIndex; lineIndex++) {
    if (SECTION_HEADING_PATTERN.test(lines[lineIndex] ?? "")) return lineIndex;
  }
  return maxLineIndex;
}

function countTasks(lines: readonly string[]): TaskCounts {
  let tasksDone = 0;
  let tasksTotal = 0;

  for (const line of lines) {
    const match = CHECKBOX_PATTERN.exec(line);
    if (!match) continue;
    tasksTotal++;
    if (match[1] === "x" || match[1] === "X") tasksDone++;
  }

  return { tasksDone, tasksTotal };
}

import { promises as fs } from "node:fs";
import path from "node:path";

// Claude Code는 SessionStart 훅 시점의 세션 ID로 캡처를 남기지만, 실제 대화 트랜스크립트는
// 다른 세션 ID 파일로 기록될 수 있다. 캡처 경로가 비어 있으면 같은 프로젝트 디렉터리에서
// 이 Operation이 만들어진 이후에 생성된(birthtime) 트랜스크립트가 정확히 하나일 때만 폴백한다 —
// 같은 프로젝트에서 동시 진행 중인 다른 세션(예: 별개 CLI 세션)의 파일을 집지 않기 위한 경계다.
// birthtime을 못 주는 파일시스템(0 이하)은 후보에 포함하되, 역시 단일 후보여야 한다.
export async function resolveTranscriptPath(capturePath: string, operationCreatedAt: number): Promise<string | null> {
  if (await transcriptFileExists(capturePath)) return capturePath;
  const dir = path.dirname(capturePath);
  const bornCutoff = operationCreatedAt - 60_000;
  try {
    const entries = await fs.readdir(dir);
    const candidates: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const candidate = path.join(dir, entry);
      const stat = await fs.stat(candidate).catch(() => null);
      if (!stat?.isFile()) continue;
      if (stat.birthtimeMs > 0 && stat.birthtimeMs < bornCutoff) continue;
      candidates.push(candidate);
      if (candidates.length > 1) return null;
    }
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

async function transcriptFileExists(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ?? false;
}

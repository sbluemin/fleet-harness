import { promises as fs } from "node:fs";

// 이전에는 SessionStart 시점의 임시 세션 ID와 실제 대화 트랜스크립트 ID가 어긋날 수 있어
// 같은 디렉터리의 .jsonl을 생성 시각으로 폴백 채택했다. 현재는 --session-id 고정과
// UserPromptSubmit 캡처로 정확한 경로가 보장되므로, 저장된 경로 자체가 존재할 때만 반환한다.
// 파일이 사라졌을 때 같은 폴더의 다른 목표·세션 기록을 대신 집지 않기 위해 폴백을 두지 않는다.
export async function resolveTranscriptPath(capturePath: string): Promise<string | null> {
  return (await transcriptFileExists(capturePath)) ? capturePath : null;
}

async function transcriptFileExists(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() ?? false;
}

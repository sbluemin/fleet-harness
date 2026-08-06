/**
 * opencode 쿼터 프로브가 `node:sqlite`(Node 실험 기능)를 동적 import하는 순간 Node가
 * ExperimentalWarning을 stderr로 내보낸다. thin 런처는 자식 Claude Code와 터미널을
 * stdio-inherit로 공유하므로 이 경고가 사용자 화면에 그대로 새어 나온다 — 구현 세부일 뿐
 * 사용자가 조치할 수 있는 내용이 아니므로 이 경고 하나만 선별 억제한다.
 */
export function suppressSqliteExperimentalWarning(): void {
  const originalEmitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    // 이 문장은 Node 코어의 sqlite ExperimentalWarning에서만 나온다 — 메시지 단일 기준으로 판정한다.
    const message = typeof warning === "string" ? warning : warning?.message ?? "";
    if (message.includes("SQLite is an experimental feature")) return;
    originalEmitWarning(warning, ...rest);
  }) as typeof process.emitWarning;
}

import fs from "node:fs";
import path from "node:path";

export interface DesktopLogger { info(message: string): void; error(message: string): void; }

export function createDesktopLogger(dir: string): DesktopLogger {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "desktop.log");
  const write = (level: string, message: string) => fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message.replace(/[\r\n]/g, " ")}\n`, { mode: 0o600 });
  return { info: (message) => write("INFO", message), error: (message) => write("ERROR", message) };
}

// 에러의 message·exit code·자식 프로세스 stderr/stdout·cause 체인을 한 줄로 펼친다. 부팅/조달 실패의 실제
// 원인(예: npm lifecycle의 `node: command not found`, code 127)은 execFile 에러의 stderr에 담겨 오는데,
// 이를 로그 파일에 남겨야 Finder 실행(stderr 미노출)과 퍼블리싱된 앱의 사용자 이슈를 진단할 수 있다.
export function describeError(error: unknown): string {
  const segments: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
    if (!(current instanceof Error)) { segments.push(String(current)); break; }
    const detail = current as Error & { code?: unknown; stderr?: unknown; stdout?: unknown };
    const extras: string[] = [];
    if (detail.code !== undefined) extras.push(`code=${String(detail.code)}`);
    if (typeof detail.stderr === "string" && detail.stderr.trim()) extras.push(`stderr=${detail.stderr.trim()}`);
    else if (typeof detail.stdout === "string" && detail.stdout.trim()) extras.push(`stdout=${detail.stdout.trim()}`);
    segments.push(extras.length ? `${current.name}: ${current.message} (${extras.join(" ")})` : `${current.name}: ${current.message}`);
    current = detail.cause;
  }
  return segments.join(" <- caused by: ");
}

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ObjectiveRecord } from "../../../objectives/shared/records/types.js";
import { readAgentSession } from "./provider-session.js";

const execFileAsync = promisify(execFile);
const RECORD_BYTES = 64 * 1024;
const RECORD_COUNT = 2048;

/** 이름과 주소는 서버에서만 해석한다. 반환값은 Console Objective 좌표이며 CLI 신원은 밖으로 나가지 않는다. */
export function createMessageRecipientResolver(options: {
  readonly objectiveRecords: () => readonly ObjectiveRecord[];
  readonly claudeConfigDir: string;
}): (to: string) => Promise<string | undefined> {
  return async (to) => {
    const agents = options.objectiveRecords();
    if (!to.startsWith("uds:")) {
      const matches = agents.filter((objectiveRecord) => readAgentSession(objectiveRecord)?.sessionName === to);
      return matches.length === 1 ? matches[0]!.id : undefined;
    }
    // 주소의 번호/PID나 Objective 태생 id로 추측하지 않는다. 재개 세션은 태생 id와 다를 수 있다.
    if (!agents.some((objectiveRecord) => readAgentSession(objectiveRecord)?.id)) return undefined;
    const registered = await registeredSocketSessions(to.slice(4), options.claudeConfigDir);
    if (registered.length !== 1) return undefined;
    const matches = options.objectiveRecords().filter((objectiveRecord) => readAgentSession(objectiveRecord)?.id === registered[0]);
    return matches.length === 1 ? matches[0]!.id : undefined;
  };
}

/**
 * Claude Code 2.1.296의 live 등록은 configDir/sessions/<pid>.json에 messagingSocketPath,
 * sessionId, procStart를 함께 쓴다. CLI 자신도 주소를 등록에 대조한 뒤 생존한 같은 프로세스인지
 * 시작 토큰으로 확인한다. 읽기만 하며 stale 등록 정리·소켓 연결·세션 기동은 하지 않는다.
 * 지원하지 않는 플랫폼/필드, 모호한 등록, 죽은 프로세스는 해석하지 않는다.
 */
async function registeredSocketSessions(socket: string, configDir: string): Promise<string[]> {
  if ((process.platform !== "darwin" && process.platform !== "linux") || !path.isAbsolute(socket) || socket.includes("\0")
    || !path.isAbsolute(configDir) || configDir.includes("\0")) return [];
  try {
    // 소켓의 realpath는 주소 표기의 /tmp ↔ /private/tmp 차이만 정규화한다. 파일명에서 신원을 얻지 않는다.
    const socketStat = await lstat(socket);
    if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.()) return [];
    const address = await realpath(socket);
    const root = await realpath(configDir);
    const directory = await realpath(path.join(root, "sessions"));
    if (directory !== path.join(root, "sessions")) return [];
    const files = (await readdir(directory)).filter((file) => /^[1-9]\d*\.json$/u.test(file));
    if (files.length > RECORD_COUNT) return [];
    const matches: string[] = [];
    for (const file of files) {
      const candidate = path.join(directory, file);
      if (await realpath(candidate).catch(() => "") !== candidate) continue;
      const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
      if (!handle) continue;
      let record: Record<string, unknown> | undefined;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > RECORD_BYTES) continue;
        const bytes = Buffer.alloc(RECORD_BYTES + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > RECORD_BYTES) continue;
        const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
        if (value && typeof value === "object" && !Array.isArray(value)) record = value as Record<string, unknown>;
      } catch {
        // CLI가 in-place로 갱신하는 중인 등록은 의견을 내지 않는다.
      } finally {
        await handle.close();
      }
      if (!record || typeof record.sessionId !== "string" || !record.sessionId
        || typeof record.messagingSocketPath !== "string" || !path.isAbsolute(record.messagingSocketPath)
        || typeof record.procStart !== "string" || !record.procStart.trim()
        || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || file !== `${record.pid}.json`) continue;
      if (await realpath(record.messagingSocketPath).catch(() => "") !== address) continue;
      // kill(pid, 0)만으로는 재사용된 PID를 구별하지 못한다. CLI와 같은 UTC/C lstart 토큰을 대조한다.
      const current = await execFileAsync("ps", ["-o", "lstart=", "-p", String(record.pid)], {
        timeout: 1000, maxBuffer: 4096, windowsHide: true, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).then(({ stdout }) => stdout.trim(), () => "");
      if (current && current === record.procStart.trim()) matches.push(record.sessionId);
      if (matches.length > 1) return matches;
    }
    return matches;
  } catch {
    return [];
  }
}

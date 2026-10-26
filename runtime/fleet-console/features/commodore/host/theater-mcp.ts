import fs from "node:fs";
import path from "node:path";

import type { AgentWorkspace } from "../../execution/host/agent/console-resident.js";

/**
 * 사령관이 가진 Theater 들의 프로젝트 MCP 서버(`.mcp.json`) — 자식은 추가 폴더의 `.mcp.json` 을 읽지 않으므로 사령관 세션이
 * 직접 읽어 좌표로 건넨다. 사용자 홈의 MCP·플러그인은 싣지 않는다. 읽은 값의 `${VAR}` 는 자식이 펼친다.
 */

type TheaterMcpServers = NonNullable<AgentWorkspace["mcpServers"]>;
type TheaterMcpServer = TheaterMcpServers[string];

const MCP_FILE = ".mcp.json";
const MAX_MCP_FILE_BYTES = 256 * 1024;
const SERVER_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * stdio 서버를 Theater 루트에서 띄우는 런처. 자식 CLI 는 stdio 서버를 자기 작업 폴더(사령관 자리)에서 띄우므로, Theater 에서
 * 쓰던 상대 경로가 그대로 맞도록 루트로 옮겨 실행한다. 코드는 고정이고 루트·명령·인자는 argv 로만 흐른다(셸 없음).
 * 받은 종료 신호를 서버에 넘기고 서버의 종료 코드로 끝난다.
 */
const LAUNCHER = [
  'const { spawn } = require("node:child_process");',
  "const [root, command, ...args] = process.argv.slice(1);",
  "process.chdir(root);",
  'const child = spawn(command, args, { stdio: "inherit", windowsHide: true });',
  'for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));',
  'child.on("error", () => process.exit(127));',
  'child.on("exit", (code) => process.exit(code ?? 1));',
].join("\n");

export interface TheaterMcpRoot { readonly theaterId: string; readonly root: string }

/**
 * Theater 순서대로 서버를 모은다. 이름이 겹치면 앞 Theater 의 것이 남고(같은 정의면 조용히, 다르면 경고), 예약된 이름·
 * 알 수 없는 모양은 건너뛴다 — 한 Theater 의 잘못된 파일이 사령관 세션을 막지 않는다.
 */
export function theaterMcpServers(theaters: readonly TheaterMcpRoot[], reserved: ReadonlySet<string>, warn: (message: string) => void = console.warn): TheaterMcpServers {
  const servers: Record<string, TheaterMcpServer> = {};
  const definitions = new Map<string, string>();
  for (const { theaterId, root } of theaters) {
    for (const [name, raw] of Object.entries(readMcpFile(root, theaterId, warn))) {
      const server = serverOf(raw, root);
      if (!server) { warn(`[objectives] commodore skipped MCP server "${name}" of Theater ${theaterId}: unsupported definition`); continue; }
      if (!SERVER_NAME.test(name) || reserved.has(name)) { warn(`[objectives] commodore skipped MCP server "${name}" of Theater ${theaterId}: reserved or invalid name`); continue; }
      const definition = JSON.stringify(raw);
      const kept = definitions.get(name);
      if (kept !== undefined) {
        if (kept !== definition) warn(`[objectives] commodore skipped MCP server "${name}" of Theater ${theaterId}: an earlier Theater defines the same name`);
        continue;
      }
      definitions.set(name, definition);
      servers[name] = server;
    }
  }
  return servers;
}

function readMcpFile(root: string, theaterId: string, warn: (message: string) => void): Record<string, unknown> {
  const file = path.join(root, MCP_FILE);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return {};
    if (stat.size > MAX_MCP_FILE_BYTES) { warn(`[objectives] commodore skipped ${MCP_FILE} of Theater ${theaterId}: larger than ${MAX_MCP_FILE_BYTES} bytes`); return {}; }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: unknown };
    return isRecord(parsed?.mcpServers) ? parsed.mcpServers : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`[objectives] commodore skipped ${MCP_FILE} of Theater ${theaterId}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function serverOf(raw: unknown, root: string): TheaterMcpServer | null {
  if (!isRecord(raw)) return null;
  const type = raw.type ?? "stdio";
  if (type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command) return null;
    const args = raw.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return null;
    if (raw.env !== undefined && !isStringRecord(raw.env)) return null;
    return { type: "stdio", command: process.execPath, args: ["-e", LAUNCHER, root, raw.command, ...args], ...(raw.env ? { env: { ...raw.env } } : {}) };
  }
  if (type === "http" || type === "sse") {
    if (typeof raw.url !== "string" || !raw.url) return null;
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) return null;
    return { type, url: raw.url, ...(raw.headers ? { headers: { ...raw.headers } } : {}) };
  }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === "string");

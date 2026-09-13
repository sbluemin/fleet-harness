import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripConsoleInternalEnv } from "../terminal/launch-env.js";
import { isRecord, type ComputerUseBackend, type ComputerUseBackendOptions, type ComputerUseResult, type ComputerUseTool } from "./computer-use-platform.js";

export interface ComputerUseInstallation {
  readonly codex: string;
  readonly pluginRoot: string;
  readonly clientHome: string;
}

const TOOL_NAMES = new Set(["list_apps", "get_app_state", "click", "perform_secondary_action", "set_value", "select_text", "scroll", "drag", "press_key", "type_text"]);
const MAX_FRAME_BYTES = 24 * 1024 * 1024;
const RPC_TIMEOUT_MS = 90_000;

export async function findComputerUseInstallation(): Promise<ComputerUseInstallation | null> {
  if (process.platform !== "darwin") return null;
  const clientHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(clientHome)) return null;
  const client = path.join(clientHome, "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient");
  for (const app of ["/Applications/ChatGPT.app", "/Applications/Codex.app", path.join(os.homedir(), "Applications/ChatGPT.app")]) {
    const resources = path.join(app, "Contents/Resources");
    const codex = path.join(resources, "codex");
    const pluginRoot = path.join(resources, "plugins/openai-bundled/plugins/computer-use");
    try {
      await Promise.all([codex, client, path.join(pluginRoot, "bin/computer-use-client-launcher")].map((file) => fs.access(file, constants.X_OK)));
      const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
      const entry = manifest?.mcpServers?.["computer-use"];
      if (entry?.command !== "./bin/computer-use-client-launcher" || JSON.stringify(entry.args) !== '["mcp"]' || entry.cwd !== ".") continue;
      return { codex, pluginRoot, clientHome };
    } catch { /* 설치되지 않았거나 호환되지 않는 번들은 다음 후보로 넘긴다. */ }
  }
  return null;
}

/** 모델 턴을 시작하지 않는다. 별도 CODEX_HOME에 ephemeral thread만 두고 native client 설치는 참조한다. */
export class MacOSComputerUseBroker implements ComputerUseBackend {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private buffer = "";
  private closed = false;
  private directory: string | null = null;
  private threadId: string | null = null;
  private stopping: Promise<void> | null = null;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly tools = new Map<string, ComputerUseTool>();
  cleanupStatus: "not_requested" | "not_needed" | "notified" | "failed" = "not_requested";
  threadReleaseStatus: "not_requested" | "not_needed" | "released" | "failed" = "not_requested";
  cleanupFailure: "timeout" | "client_unavailable" | "client_exit" | null = null;

  constructor(private readonly deps: ComputerUseBackendOptions & { readonly installation: ComputerUseInstallation }) {}

  async start(): Promise<void> {
    await fs.mkdir(this.deps.directory, { recursive: true, mode: 0o700 });
    this.directory = await fs.mkdtemp(path.join(this.deps.directory, "broker-"));
    if (this.closed) { await this.removeDirectory(); throw new Error("computer_use_stopped"); }
    const env = stripConsoleInternalEnv(process.env);
    delete env.FLEET_CONSOLE_SESSION_ID;
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    env.CODEX_HOME = this.directory;
    const child = spawn(this.deps.installation.codex, ["app-server", "--stdio", "--enable", "computer_use", "--enable", "plugins", "--enable", "tool_call_mcp_elicitation"], {
      cwd: this.directory, env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // stderr에는 경로·인증 정보가 포함될 수 있다. 브라우저나 일반 로그에 싣지 않는다.
    child.stderr.resume();
    child.stdin.on("error", () => { this.fail(new Error("computer_use_connection_lost")); void this.stop(); });
    child.on("error", () => { this.fail(new Error("computer_use_process_failed")); void this.stop(); });
    child.on("exit", () => { this.fail(new Error("computer_use_process_exited")); void this.stop(); });
    try {
      await this.request("initialize", {
        clientInfo: { name: "fleet-computer-use", version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.write({ method: "initialized" });
      const { pluginRoot, clientHome } = this.deps.installation;
      const started = await this.request("thread/start", {
        ephemeral: true, cwd: this.directory, approvalPolicy: "on-request", sandbox: "read-only",
        config: {
          features: { computer_use: true, plugins: true, tool_call_mcp_elicitation: true },
          mcp_servers: { "computer-use": {
            command: path.join(pluginRoot, "bin/computer-use-client-launcher"), args: ["mcp"], cwd: pluginRoot,
            env: { CODEX_HOME: clientHome }, enabled: true,
          } },
        },
      }) as { thread?: { id?: string } };
      if (typeof started?.thread?.id !== "string") throw new Error("computer_use_invalid_thread");
      this.threadId = started.thread.id;
      const deadline = Date.now() + 45_000;
      do {
        let cursor: string | null = null;
        let pages = 0;
        do {
          const status = await this.request("mcpServerStatus/list", { threadId: this.threadId, detail: "toolsAndAuthOnly", cursor }) as {
            data?: Array<{ name: string; tools?: Record<string, ComputerUseTool> }>; nextCursor?: string | null;
          };
          for (const server of status.data ?? []) {
            if (server.name !== "computer-use") continue;
            for (const tool of Object.values(server.tools ?? {})) {
              if (TOOL_NAMES.has(tool.name) && tool.inputSchema?.type === "object") this.tools.set(tool.name, tool);
            }
          }
          cursor = status.nextCursor ?? null;
          if (++pages > 20) throw new Error("computer_use_invalid_inventory");
        } while (cursor);
        if (this.tools.has("list_apps") && this.tools.has("get_app_state")) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (!this.closed && Date.now() < deadline);
      throw new Error("computer_use_tools_unavailable");
    } catch (error) { await this.stop(); throw error; }
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ComputerUseResult> {
    if (!this.threadId || !this.tools.has(tool)) throw new Error("computer_use_tool_unavailable");
    const value = await this.request("mcpServer/tool/call", { threadId: this.threadId, server: "computer-use", tool, arguments: args });
    if (!isRecord(value) || !Array.isArray(value.content) || value.content.some((block) => !isRecord(block))) throw new Error("computer_use_invalid_result");
    return { content: value.content, isError: value.isError === true } as ComputerUseResult;
  }

  private request(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("computer_use_stopped"));
    if (method !== "mcpServer/tool/call") this.deps.onStage?.(method);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("computer_use_timeout_outcome_unknown"));
        void this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch { this.fail(new Error("computer_use_connection_lost")); }
    });
  }

  private write(message: unknown): void {
    if (this.closed || !this.process?.stdin.writable) throw new Error("computer_use_stopped");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) { this.fail(new Error("computer_use_response_too_large")); void this.stop(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); if (!isRecord(message)) throw new Error(); }
      catch { this.fail(new Error("computer_use_invalid_response")); void this.stop(); return; }
      if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
        void this.respond(message);
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error("computer_use_upstream_error"));
        else pending.resolve(message.result);
      }
    }
  }

  private async respond(message: Record<string, unknown>): Promise<void> {
    const params = message.params;
    try {
      if (message.method !== "mcpServer/elicitation/request" || !isRecord(params) || params.serverName !== "computer-use" || params.threadId !== this.threadId) {
        this.write({ id: message.id, error: { code: -32601, message: "Unsupported request" } });
        return;
      }
      // URL·본인 확인·알 수 없는 폼은 자동 승인하지 않는다. 영구 허용도 대신 작성하지 않는다.
      const schema = params.requestedSchema;
      const emptyForm = params.mode === "form" && isRecord(schema) && schema.type === "object"
        && (schema.properties === undefined || (isRecord(schema.properties) && Object.keys(schema.properties).length === 0))
        && (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0));
      const accepted = emptyForm && await this.deps.approve(params);
      if (!this.closed) this.write({ id: message.id, result: { action: accepted ? "accept" : "decline", content: accepted ? {} : null, _meta: null } });
    } catch { if (!this.closed) void this.stop(); }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const threadId = this.threadId;
    const cwd = this.directory;
    this.threadId = null;
    this.tools.clear();
    this.fail(new Error("computer_use_stopped"));
    const child = this.process;
    const release = threadId && child?.stdin.writable && child.exitCode === null && child.signalCode === null
      ? this.request("thread/unsubscribe", { threadId }, 3_000) : null;
    this.closed = true;
    this.stopping = (async () => {
      this.threadReleaseStatus = threadId ? "failed" : "not_needed";
      if (release) {
        try {
          const value = await release;
          if (isRecord(value) && (value.status === "unsubscribed" || value.status === "notSubscribed" || value.status === "notLoaded")) this.threadReleaseStatus = "released";
        } catch { /* 프로토콜 종료가 실패해도 소유한 프로세스 회수는 계속한다. */ }
      }
      // 인스턴스가 생성한 thread만 종료 알림으로 회수한다. 공유 native 서비스 자체는 죽이지 않는다.
      this.cleanupStatus = threadId ? "failed" : "not_needed";
      if (threadId) {
        const client = path.join(this.deps.installation.clientHome, "computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient");
        const env = stripConsoleInternalEnv(process.env);
        delete env.FLEET_CONSOLE_SESSION_ID;
        env.CODEX_HOME = this.deps.installation.clientHome;
        await new Promise<void>((resolve) => {
          execFile(client, ["turn-ended", JSON.stringify({ type: "agent-turn-complete", "thread-id": threadId, cwd: cwd ?? "", "input-messages": [], "last-assistant-message": "" })], { env, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error) => {
            this.cleanupStatus = error ? "failed" : "notified";
            this.cleanupFailure = !error ? null : error.killed ? "timeout" : error.code === "ENOENT" || error.code === "EACCES" ? "client_unavailable" : "client_exit";
            resolve();
          });
        });
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          child.once("error", () => { clearTimeout(timer); resolve(); });
          child.stdin.end();
          child.kill("SIGTERM");
        });
      }
      await this.removeDirectory();
    })();
    return this.stopping;
  }

  private async removeDirectory(): Promise<void> {
    const directory = this.directory;
    this.directory = null;
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

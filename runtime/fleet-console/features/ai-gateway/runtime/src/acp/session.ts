import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";

import {
  AcpAuthRequiredError,
  AcpModelUnavailableError,
  type AcpPromptBlock,
  type AcpSession,
  type AcpSessionEvent,
  type AcpSessionOpenOptions,
  type AcpSessionPort,
} from "./contract.js";
import { createSessionUpdateNormalizer, toTurnEnd } from "./events.js";
import { JsonRpcClosedError, JsonRpcError, createJsonRpcPeer, type JsonRpcPeer } from "./jsonrpc.js";
import { isAcpModelAvailable, resolveAcpModelSelection } from "./models.js";
import { agyAcpStateArgs, resolveAgySessionPaths } from "./paths.js";
import { toolOnlyTitlePrefix, writeToolOnlyLayout } from "./tool-only.js";

const ACP_PROTOCOL_VERSION = 1;
const STARTUP_TIMEOUT_MS = 120_000;
const AUTH_REQUIRED_CODE = -32000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 4_096;

export interface AgyAcpPortOptions {
  /** 세션 전용 gemini-dir들의 부모(Fleet 데이터 루트 아래의 절대경로). 세션마다 `<sessionsDir>/<key>`가 생기고 닫을 때 지워진다. */
  readonly sessionsDir: string;
  /** agy 실행 파일. 기본은 `FLEET_ANTIGRAVITY_CLI` 또는 PATH의 `agy`. */
  readonly command?: string;
  /** 실행 파일 앞에 붙일 인자(테스트가 스크립트를 띄울 때 쓴다). */
  readonly commandArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** 와이어가 보낸 `session/new` 응답에서 우리가 읽는 부분. */
interface NewSessionResult {
  readonly sessionId?: unknown;
  readonly models?: { readonly availableModels?: unknown };
  readonly configOptions?: unknown;
}

interface ConfigOption {
  readonly id: string;
  readonly values: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function availableModelIds(result: NewSessionResult): string[] {
  const ids = new Set<string>();
  const models = result.models?.availableModels;
  if (Array.isArray(models)) {
    for (const model of models) {
      const entry = record(model);
      const id = entry?.modelId ?? entry?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  for (const option of configOptions(result)) {
    if (option.id === "model") for (const value of option.values) ids.add(value);
  }
  return [...ids];
}

function configOptions(result: NewSessionResult): ConfigOption[] {
  if (!Array.isArray(result.configOptions)) return [];
  return result.configOptions.flatMap((raw): ConfigOption[] => {
    const entry = record(raw);
    if (!entry || typeof entry.id !== "string") return [];
    const options = Array.isArray(entry.options) ? entry.options : [];
    const values = options.flatMap((option): string[] => {
      const row = record(option);
      return typeof row?.value === "string" ? [row.value] : [];
    });
    return [{ id: entry.id, values }];
  });
}

function toWirePrompt(blocks: readonly AcpPromptBlock[]): unknown[] {
  return blocks.map((block) => block.kind === "text"
    ? { type: "text", text: block.text }
    : { type: "image", mimeType: block.mimeType, data: block.data });
}

/** 한 턴의 이벤트를 쌓고 소비자가 하나씩 꺼내 가는 큐. */
class EventQueue {
  private readonly items: AcpSessionEvent[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(event: AcpSessionEvent): void {
    if (this.ended) return;
    this.items.push(event);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<AcpSessionEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        if (next.kind === "turn-end" || next.kind === "exit") return;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

class AgyAcpSession implements AcpSession {
  private queue: EventQueue | undefined;
  private normalize = createSessionUpdateNormalizer();
  private closed = false;
  private childExited = false;

  constructor(
    readonly sessionId: string,
    readonly wireModel: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly rpc: JsonRpcPeer,
    private readonly cleanup: () => Promise<void>,
  ) {}

  /** 연결 쪽이 부른다: 이 세션의 업데이트 한 건. 턴 밖의 업데이트(명령 목록 등)는 버린다. */
  handleUpdate(update: unknown): void {
    for (const event of this.normalize(update)) this.queue?.push(event);
  }

  handleExit(code: number | null, detail: string | undefined): void {
    this.childExited = true;
    this.queue?.push({ kind: "exit", code, ...(detail ? { detail } : {}) });
    this.queue?.end();
  }

  prompt(blocks: readonly AcpPromptBlock[]): AsyncIterable<AcpSessionEvent> {
    if (this.queue) throw new Error("An agy ACP turn is already running on this session.");
    if (this.closed || this.childExited) throw new Error("The agy ACP session is closed.");
    const queue = new EventQueue();
    this.queue = queue;
    this.normalize = createSessionUpdateNormalizer();
    this.rpc.request("session/prompt", { sessionId: this.sessionId, prompt: toWirePrompt(blocks) }).then(
      (result) => {
        queue.push(toTurnEnd(record(result)?.stopReason, record(result)?.usage));
        queue.end();
      },
      (error: unknown) => {
        // 자식이 죽어서 끊긴 요청은 `exit`가 이미 알렸다.
        if (error instanceof JsonRpcClosedError) { queue.end(); return; }
        queue.push({ kind: "turn-end", stopReason: "error", detail: error instanceof Error ? error.message : String(error) });
        queue.end();
      },
    );
    const session = this;
    return (async function* () {
      try {
        yield* queue.drain();
      } finally {
        if (session.queue === queue) session.queue = undefined;
      }
    })();
  }

  async cancel(): Promise<void> {
    if (this.closed || this.childExited) return;
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue?.end();
    this.rpc.dispose();
    await terminate(this.child);
    await this.cleanup();
  }
}

function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    child.once("close", () => { clearTimeout(kill); resolve(); });
    child.stdin.end();
    child.kill("SIGTERM");
  });
}

/**
 * `agy acp`를 세션마다 하나씩 띄우는 포트 구현.
 *
 * resume·loadSession은 쓰지 않는다 — Fleet이 다시 떠도 언제나 `session/new`다.
 * 내장 도구는 없다(`toolOnly`): 권한 요청은 그 서버의 도구 호출만 허용하고 나머지는 모두 거절한다.
 */
export function createAgyAcpSessionPort(options: AgyAcpPortOptions): AcpSessionPort {
  const env = options.env ?? process.env;
  const command = options.command ?? env.FLEET_ANTIGRAVITY_CLI ?? "agy";

  return {
    async open(open: AcpSessionOpenOptions): Promise<AcpSession> {
      const selection = resolveAcpModelSelection(open.model, open.thoughtLevel);
      const paths = resolveAgySessionPaths(options.sessionsDir, open.sessionKey ?? randomUUID());
      const removeSessionDir = (): Promise<void> => rm(paths.geminiDir, { recursive: true, force: true });
      let layout: Awaited<ReturnType<typeof writeToolOnlyLayout>>;
      try {
        await mkdir(paths.geminiDir, { recursive: true });
        layout = await writeToolOnlyLayout(paths.geminiDir, open.toolOnly);
      } catch (error) {
        await removeSessionDir();
        throw error;
      }
      const args = [
        ...(options.commandArgs ?? []),
        "acp",
        ...agyAcpStateArgs(paths),
        ...layout.args,
      ];
      const child = spawn(command, args, { cwd: layout.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stderrTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
      });

      let session: AgyAcpSession | undefined;
      let sessionId: string | undefined;
      const rpc = createJsonRpcPeer(child, {
        onNotification: (method, params) => {
          if (method !== "session/update") return;
          const body = record(params);
          if (body === undefined || body.sessionId !== sessionId || session === undefined) return;
          session.handleUpdate(body.update);
        },
        onRequest: (method, params) => {
          if (method === "session/request_permission") {
            return toolOnlyOutcome(params, toolOnlyTitlePrefix(open.toolOnly.serverName));
          }
          throw new JsonRpcError(-32601, `Method not supported: ${method}`);
        },
        onClose: () => {
          session?.handleExit(child.exitCode, stderrTail.trim() || undefined);
        },
      });

      const abort = (): void => { void closeAll(); };
      let torn = false;
      const closeAll = async (): Promise<void> => {
        if (torn) return;
        torn = true;
        open.signal?.removeEventListener("abort", abort);
        if (session) await session.close();
        else { rpc.dispose(); await terminate(child); await removeSessionDir(); }
      };
      if (open.signal?.aborted) { await closeAll(); throw new Error("agy ACP session open was aborted."); }
      open.signal?.addEventListener("abort", abort, { once: true });

      try {
        await rpc.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "fleet", version: "1" },
        }, { timeoutMs: STARTUP_TIMEOUT_MS });
        const created = await rpc.request<NewSessionResult>("session/new", {
          cwd: layout.cwd,
          // 서버는 ACP가 아니라 gemini-dir의 설정 파일로 붙는다(tool-only.ts).
          mcpServers: [],
          _meta: { antigravity: { systemPrompt: { append: open.systemPrompt } } },
        }, { timeoutMs: STARTUP_TIMEOUT_MS });
        const id = typeof created.sessionId === "string" ? created.sessionId : undefined;
        if (!id) throw new Error("agy did not return a session id.");
        sessionId = id;

        const available = availableModelIds(created);
        if (!isAcpModelAvailable(selection.baseId, available)) {
          throw new AcpModelUnavailableError(selection.catalogId, available);
        }
        const options = configOptions(created);
        await rpc.request("session/set_config_option", { sessionId: id, configId: "model", value: selection.baseId }, { timeoutMs: STARTUP_TIMEOUT_MS });
        const thought = options.find((option) => option.id === "thought_level");
        if (thought && thought.values.includes(selection.thoughtLevel)) {
          await rpc.request("session/set_config_option", { sessionId: id, configId: "thought_level", value: selection.thoughtLevel }, { timeoutMs: STARTUP_TIMEOUT_MS });
        }
        session = new AgyAcpSession(id, selection.baseId, child, rpc, removeSessionDir);
        if (open.signal?.aborted) throw new Error("agy ACP session open was aborted.");
        return session;
      } catch (error) {
        await closeAll();
        if (error instanceof JsonRpcError && error.code === AUTH_REQUIRED_CODE) throw new AcpAuthRequiredError();
        if (error instanceof JsonRpcClosedError && stderrTail.trim().length > 0) {
          throw new Error(`agy acp exited before the session opened: ${stderrTail.trim()}`);
        }
        throw error;
      }
    },
  };
}

/** 내장 도구 없는 모드의 권한 규칙: 이 서버의 도구 호출만 허용하고 나머지는 모두 거절한다. */
function toolOnlyOutcome(params: unknown, titlePrefix: string): unknown {
  const body = record(params);
  const title = record(body?.toolCall)?.title;
  const options = Array.isArray(body?.options) ? body.options.flatMap((option) => (record(option) ? [record(option)!] : [])) : [];
  const wanted = typeof title === "string" && title.startsWith(titlePrefix) ? "allow_once" : "reject_once";
  const choice = options.find((row) => row.kind === wanted);
  return typeof choice?.optionId === "string"
    ? { outcome: { outcome: "selected", optionId: choice.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

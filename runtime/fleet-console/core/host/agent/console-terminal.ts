import { promises as fs, statSync } from "node:fs";
import type { ConsoleOperationObservation } from "@fleet-console/sdk/mcp";
import { chatShellTailFromOutput } from "./chat-events.js";
import { LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX } from "@dotobokuri/fleet-admiral";

export type TerminalOutcome = "completed" | "failed" | "interrupted" | "unknown";
type PublicOutput = ConsoleOperationObservation["output"];
interface PendingTurn {
  readonly prompt: string;
  readonly firstTurn: boolean;
  readonly settle: (outcome: TerminalOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  started: boolean;
  interrupt?: (confirmed: boolean) => void;
}
interface OutputState { generation: number; output: PublicOutput; transcriptOffset?: number }

/** PTY 화면 바이트가 아니라 CLI가 남긴 공개 답변과 턴 경계를 읽는다. */
export function createConsoleTerminalObserver(deps: {
  readonly transcript: (operationId: string) => string | undefined;
  readonly cwd: (operationId: string) => string | undefined;
}) {
  const pending = new Map<string, PendingTurn>();
  const outputs = new Map<string, OutputState>();
  let disposed = false;
  const unavailable = (): PublicOutput => ({ status: "unavailable", outcome: "unknown", source: "terminal_hook" });
  function complete(id: string, outcome: TerminalOutcome) {
    const turn = pending.get(id);
    if (!turn) return;
    pending.delete(id); clearTimeout(turn.timer);
    turn.interrupt?.(outcome !== "unknown");
    turn.settle(outcome);
  }
  function begin(id: string, prompt: string, firstTurn: boolean, settle: (outcome: TerminalOutcome) => void) {
    if (disposed || pending.has(id)) return false;
    const timer = setTimeout(() => complete(id, "unknown"), 24 * 60 * 60_000);
    timer.unref();
    pending.set(id, { prompt: prompt.trim(), firstTurn, settle, timer, started: false });
    return true;
  }
  function parse(input: unknown): Record<string, unknown> {
    try { const value = typeof input === "string" ? JSON.parse(input) : input; return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  }
  function start(id: string, input: unknown) {
    const hook = parse(input);
    const turn = pending.get(id);
    if (turn) {
      // 새 launch는 Fleet의 파일 포인터가 첫 프롬프트다. 기존 세션 전송은 원문 일치를 확인한다.
      const prompt = typeof hook.prompt === "string" ? hook.prompt.trim() : undefined;
      const matched = prompt === turn.prompt || (turn.firstTurn && prompt?.startsWith(LAUNCH_PROMPT_FILE_INSTRUCTION_PREFIX) === true);
      if (turn.started || !matched) complete(id, "unknown");
      else turn.started = true;
    }
    const generation = (outputs.get(id)?.generation ?? 0) + 1;
    let transcriptOffset: number | undefined;
    const file = deps.transcript(id);
    if (file) { try { transcriptOffset = statSync(file).size; } catch { transcriptOffset = 0; } }
    outputs.set(id, { generation, transcriptOffset, output: { ...unavailable(), outcome: "running", revision: generation } });
  }
  async function end(id: string, input: unknown) {
    const hook = parse(input);
    const state: OutputState = outputs.get(id) ?? { generation: 0, output: unavailable() };
    if (!outputs.has(id)) outputs.set(id, state);
    const turn = pending.get(id);
    const interrupted = !!turn?.interrupt;
    const outcome = interrupted ? "interrupted" : "completed";
    let raw = typeof hook.last_assistant_message === "string" ? hook.last_assistant_message : undefined;
    let truncated = false;
    let source: "terminal_hook" | "terminal_transcript" = "terminal_hook";
    if (!raw) {
      // 캡처된 정확한 파일만 읽는다. 주변 파일을 찾아 다른 세션의 답변을 섞지 않는다.
      const file = deps.transcript(id);
      if (file && state.transcriptOffset !== undefined) {
        try {
          const handle = await fs.open(file, "r");
          try {
            const stat = await handle.stat();
            if (stat.isFile()) {
              const cap = 512 * 1024;
              const offset = Math.max(0, stat.size - cap, Math.min(state.transcriptOffset ?? 0, stat.size));
              const buffer = Buffer.alloc(stat.size - offset);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
              let tail = buffer.subarray(0, bytesRead).toString("utf8");
              if (offset > 0 && offset !== state.transcriptOffset) { tail = tail.slice(tail.indexOf("\n") + 1); truncated = true; }
              const messages: string[] = [];
              for (const line of tail.split("\n")) {
                try {
                  const record = JSON.parse(line);
                  if (record.isSidechain === true) continue;
                  const content = record.message?.content;
                  if (record.type === "user" && (typeof content === "string" || (Array.isArray(content) && content.some((part: { type?: string }) => part.type === "text")))) messages.length = 0;
                  if (record.type === "assistant" && Array.isArray(content)) for (const part of content) if (part.type === "text" && typeof part.text === "string") messages.push(part.text);
                } catch { /* 끝의 미완성 JSONL 줄은 다음 조회에 맡긴다. */ }
              }
              raw = messages.join("\n\n") || undefined;
              source = "terminal_transcript";
            }
          } finally { await handle.close(); }
        } catch { /* 파일 부재는 성공이나 빈 답변으로 꾸미지 않는다. */ }
      }
    }
    if (disposed || outputs.get(id) !== state) return;
    const safe = raw ? chatShellTailFromOutput(raw, { cwd: deps.cwd(id) }) : null;
    state.output = { status: safe?.tail ? "available" : "unavailable", ...(safe?.tail ? { text: safe.tail, truncated: truncated || safe.truncated } : {}), outcome, source, revision: state.generation };
    // Stop은 목표 성공이 아니라 CLI 턴 종료의 증거다. 매칭한 요청에만 완료를 귀속한다.
    if (pending.get(id) === turn && turn?.started) complete(id, outcome);
  }
  async function interrupt(id: string, write: () => boolean): Promise<boolean> {
    const existing = pending.get(id);
    if (existing?.interrupt) return false;
    let owned = false;
    if (!existing) { owned = begin(id, "", true, () => {}); const turn = pending.get(id); if (turn) turn.started = true; }
    const turn = pending.get(id);
    if (!turn) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<boolean>((resolve) => {
        turn.interrupt = resolve;
        timer = setTimeout(() => resolve(false), 25_000);
        if (!write()) resolve(false);
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (pending.get(id) === turn) {
        delete turn.interrupt;
        if (owned) complete(id, "unknown");
      }
    }
  }
  return {
    begin, start, end, interrupt,
    busy: (id: string) => pending.has(id),
    read: (id: string): PublicOutput => outputs.get(id)?.output ?? unavailable(),
    cancel(id: string) { complete(id, "unknown"); },
    forget(id: string) { complete(id, "unknown"); outputs.delete(id); },
    dispose() { disposed = true; for (const id of pending.keys()) complete(id, "unknown"); outputs.clear(); },
  };
}

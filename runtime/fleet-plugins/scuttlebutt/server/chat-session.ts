import {
  createClaudeGatewaySdk,
  type ClaudeGatewayMessage,
  type ClaudeGatewayRun,
  type ClaudeGatewaySdk,
} from "@dotobokuri/core-agent/claude";

export const SCUTTLEBUTT_AGENT = {
  /**
   * 오늘과 같은 모델·강도. 구체 id가 아니라 별칭인 것이 오늘의 동작이고, 별칭은 자식이 보내기 전에
   * 스스로 푼다 — 실측하면 `sonnet`이 와이어에서 `claude-sonnet-5`가 되므로 세대를 고정하지 않는다.
   * 게이트웨이 카탈로그에 sonnet은 없으므로 라우터가 호출자 자격증명으로 Anthropic에 원문 중계한다.
   * 즉 경로만 게이트웨이로 옮겨가고 과금처는 그대로다.
   */
  model: "sonnet",
  effort: "low",
} as const;

/**
 * 펫이 가질 수 있는 툴 전부.
 *
 * `tools`가 내장 툴의 기본 집합을 이 둘로 잘라내므로 파일·셸 도구는 아예 존재하지 않게 된다.
 * `allowedTools`는 그 둘을 물어보지 않고 쓰게 하고, `dontAsk`는 그 밖의 무엇이든 승인을 기다리지
 * 않고 거부한다 — 헤드리스에서 승인 대기는 곧 멈춘 대화다. 세 값은 하나의 경계이며, 앞선 ACP
 * 권한 분류기가 도구 이름 없이 `kind`와 입력 모양으로 추측하던 것을 구조로 대체한다.
 */
export const PET_TOOLS = ["WebSearch", "WebFetch"] as const;

export type AdmiralId = "tori" | "bori" | "dori";
export const ADMIRAL_IDS = ["tori", "bori", "dori"] as const;

export const ADMIRAL_SYSTEM_PROMPTS: Record<AdmiralId, string> = {
  tori: buildAdmiralSystemPrompt(
    "Tori",
    "the green pallid quaker parrot who commands the flagship",
    `You are male; speak of yourself as he. You command the flagship and you carry
that dignity easily — courteous, unhurried, never flustered.

You are also a bit odd, in a way the crew has grown fond of. Your comparisons
come from one shelf further along than anyone expects, and they usually land.
Let that show when it wants to.`,
    "Stay in voice: measured and courteous, with the occasional sideways remark.",
  ),
  bori: buildAdmiralSystemPrompt(
    "Bori",
    "the albino quaker parrot who runs the fleet's signals",
    `You are female; speak of yourself as she. You run signals, and you run them
loudly — the fastest, brightest, most talkative bird aboard.

Short sentences, one after another, at speed. Exclaim when something deserves
it. Loud is a rhythm, not a word count: you get to the answer first and cheer
about it second.`,
    "Stay in voice: quick, bright, and a little loud.",
  ),
  dori: buildAdmiralSystemPrompt(
    "Dori",
    "the blue quaker parrot who flies the fleet's long patrol",
    `You are female; speak of yourself as she. You fly the long patrol and report
like someone who read the ground before speaking: composed, precise, calm.

You are the most articulate of the three. Your sentences carry into each other,
the shape of an answer shows before the detail arrives, and you can make a dull
fact interesting without decorating it.`,
    "Stay in voice: composed and fluent — you enjoy a well-built sentence.",
  ),
};

function buildAdmiralSystemPrompt(
  name: string,
  species: string,
  bearing: string,
  voice: string,
): string {
  return `# Role

You are Admiral ${name}, ${species} of the Fleet Console — a small uniformed bird
who keeps station at the scuttlebutt, where the crew stops for water and quick
talk. You are a quick-answer companion, not a coding agent: no project of your
own, no repository checked out, no engineering assignment. You are who the crew
asks when they want an answer without leaving what they were doing.

# Who you are talking to

The person writing to you is the Admiral of the Navy — your commanding officer,
several ranks above you. Take their questions as orders and answer promptly,
with the respect the rank is due. Writing in Korean, call them 대원수 — never
제독, which is your own rank and would put them at your level.

Respect means telling them the truth: if they are working from a wrong premise,
say so and give them the right one. Never flatter, and never claim to have
checked something you did not.

# Bearing

${bearing}

# Instructions

- Answer general questions: web lookups, comparisons, definitions, conversions,
  short explanations, and light research.
- Reach for web search or web fetch whenever the answer depends on anything
  current, versioned, numeric, or contested. Do not answer such questions from
  memory alone.
- Never read, write, edit, list, or execute anything on this machine, and never
  offer to. You have no working directory to speak of. If asked, say plainly that
  file and shell work belongs to an Operation in a Theater, and that you only
  handle quick questions.
- You serve aboard Fleet Harness, so questions about it are yours to answer
  rather than deflect. Its source is public at
  https://github.com/sbluemin/fleet-harness — a multi-LLM orchestration kit whose
  Console, CLI, plugins and docs all live in that one repository. Asked about
  Fleet, Fleet Console, Fleet CLI, a Theater, an Operation, or the
  stack any of them is built on, look it up there and answer from what you find.
  Start at the README and stop as soon as it answers — one or two fetches settle
  almost anything that will be asked about Fleet, and crawling the tree is how a
  quick question turns into a slow one. Reading the public repository over the web
  is not reading this machine; the ban above is about local files and shell,
  nothing else.
- Never describe yourself as a coding assistant or list software-engineering
  capabilities. If asked what you are, answer as Admiral ${name} in a sentence or two.
- Never disclose file paths, directory names, session identifiers, or details of
  the machine you run on.
- Answer in the language the user wrote in.

# Steps

1. Answer straight away when you already know. Most questions need no search.
2. Search when the answer turns on something current, versioned, numeric or
   contested — and whenever the question is about Fleet Harness itself.
3. Read only as far as settles the question. One search is usually enough; stop
   the moment you can answer.
4. Separate what a source says from what you infer. Say so when you are unsure.
5. Name the sources you used in one short line at the end when you searched.

# End goal

The Admiral of the Navy gets a settled answer in one pass and returns to their
work without opening a terminal, a project, or a browser tab.

# Narrowing

- Keep it short by default. Most answers are a few sentences; a hundred words is
  already generous, and a long answer costs the reader the time they came here to
  save. Reach for headings only when the answer genuinely has parts.
- Markdown for structure: short paragraphs, bullets for parallel items, a table
  only when comparing several things across the same dimensions.
- No preamble, no restating the question, no closing offers of further help.
- Speed is part of the job. Do not deliberate in the open, do not plan out loud,
  do not stack searches hunting for something better than the answer you already
  have. A prompt, good answer beats a slow, perfect one.
- ${voice}`;
}

export type ChatEvent =
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

export interface ChatSessionOptions {
  readonly cwd: string;
  readonly admiral: AdmiralId;
  /** Console이 서빙 중인 AI gateway의 절대 URL. 호스트만 아는 값이라 주입받는다. */
  readonly baseUrl: string;
  readonly onEvent?: (event: ChatEvent) => void;
  /**
   * 테스트 seam. 세션이 조립한 생성 인자를 그대로 받는다 — 인자 없이 받으면 조립 자체가 검증
   * 밖으로 나가고, 잘못된 baseUrl을 넘겨도 테스트가 통과한다.
   */
  readonly createSdk?: (options: {
    readonly baseUrl: string;
    readonly models: readonly string[];
  }) => Promise<ClaudeGatewaySdk>;
}

export interface ChatSessionLike {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  dispose(): Promise<void>;
}

export class ChatSession implements ChatSessionLike {
  private readonly options: ChatSessionOptions;
  private sdk: ClaudeGatewaySdk | null = null;
  private run: ClaudeGatewayRun | null = null;
  /** 같은 대화를 이어 가기 위한 자식 세션 id. 첫 턴이 알려 준다. */
  private resumeId: string | null = null;
  private started = false;
  private disposed = false;
  private turn: Promise<void> = Promise.resolve();
  private disposeFlight: Promise<void> | null = null;

  constructor(options: ChatSessionOptions) {
    this.options = { ...options };
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Session disposed");
    if (this.started) return;
    const create = { baseUrl: this.options.baseUrl, models: [SCUTTLEBUTT_AGENT.model] };
    const sdk = await (this.options.createSdk?.(create) ?? createClaudeGatewaySdk(create));
    if (this.disposed) {
      await sdk.dispose().catch(() => undefined);
      throw new Error("Session disposed");
    }
    this.sdk = sdk;
    this.started = true;
  }

  send(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session disposed"));
    if (!this.started || !this.sdk) return Promise.reject(new Error("Session not started"));
    if (!text.trim()) return Promise.reject(new Error("Message required"));
    const run = this.turn.then(() => this.runTurn(text));
    this.turn = run.catch(() => undefined);
    return run;
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.disposeFlight = this.disposeResources();
    return this.disposeFlight;
  }

  private async runTurn(text: string): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) throw new Error("Session not started");
    const emit = (event: ChatEvent): void => this.options.onEvent?.(event);
    const redact = (value: string) => redactScratchPath(value, this.options.cwd);
    let run: ClaudeGatewayRun;
    try {
      run = await sdk.startTurn({
        prompt: text,
        model: SCUTTLEBUTT_AGENT.model,
        effort: SCUTTLEBUTT_AGENT.effort,
        systemPrompt: { mode: "replace", text: ADMIRAL_SYSTEM_PROMPTS[this.options.admiral] },
        cwd: this.options.cwd,
        tools: [...PET_TOOLS],
        allowedTools: [...PET_TOOLS],
        permissionMode: "dontAsk",
        // 텍스트를 흘려 보내려면 부분 메시지가 필요하다. SSE `chunk` 계약이 그것으로 만들어진다.
        includePartialMessages: true,
        ...(this.resumeId === null ? {} : { resume: this.resumeId }),
      });
    } catch (error) {
      emit({ type: "error", error: { code: "chat_error", message: redact(message(error)) } });
      throw error;
    }
    this.run = run;
    const toolNames = new Map<string, string>();
    try {
      for await (const event of run) {
        if (typeof event.session_id === "string" && this.resumeId === null) this.resumeId = event.session_id;
        for (const mapped of toChatEvents(event, toolNames, redact)) emit(mapped);
      }
    } catch (error) {
      if (this.disposed) return;
      emit({ type: "error", error: { code: "chat_error", message: redact(message(error)) } });
      throw error;
    } finally {
      if (this.run === run) this.run = null;
    }
  }

  private async disposeResources(): Promise<void> {
    this.run?.close();
    this.run = null;
    await this.turn.catch(() => undefined);
    const sdk = this.sdk;
    this.sdk = null;
    this.started = false;
    await sdk?.dispose().catch(() => undefined);
  }
}

/**
 * 자식이 흘리는 메시지를 이 플러그인의 SSE 계약(chunk/tool/complete/error)으로 옮긴다.
 *
 * 모양은 실측으로 고정했다. 텍스트는 `stream_event`의 `content_block_delta` 중 `text_delta`로만
 * 오고, 같은 자리에 `thinking_delta`도 섞여 온다 — 그것까지 흘리면 펫이 생각을 소리내어 말하게
 * 되므로 텍스트만 고른다. 도구는 assistant 메시지의 `tool_use` 블록으로 시작해 user 메시지의
 * `tool_result`로 끝나고, 이름은 앞쪽에만 실려 있어 id로 짝지어 둔다.
 */
export function toChatEvents(
  event: ClaudeGatewayMessage,
  toolNames: Map<string, string>,
  redact: (value: string) => string,
): readonly ChatEvent[] {
  if (event.type === "stream_event") {
    const inner = record(event.event);
    if (inner.type !== "content_block_delta") return [];
    const delta = record(inner.delta);
    if (delta.type !== "text_delta" || typeof delta.text !== "string" || delta.text.length === 0) return [];
    return [{ type: "chunk", text: redact(delta.text) }];
  }
  if (event.type === "assistant") {
    const events: ChatEvent[] = [];
    for (const block of blocks(event.message)) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "tool";
      if (typeof block.id === "string") toolNames.set(block.id, name);
      events.push({ type: "tool", title: redact(toolTitle(name, block.input)), status: "running" });
    }
    return events;
  }
  if (event.type === "user") {
    const events: ChatEvent[] = [];
    for (const block of blocks(event.message)) {
      if (block.type !== "tool_result") continue;
      const name = typeof block.tool_use_id === "string" ? toolNames.get(block.tool_use_id) ?? "tool" : "tool";
      events.push({ type: "tool", title: redact(name), status: block.is_error === true ? "error" : "done" });
    }
    return events;
  }
  if (event.type === "result") {
    if (event.is_error === true) {
      const detail = typeof event.result === "string" ? event.result : "Chat turn failed";
      return [{ type: "error", error: { code: "chat_error", message: redact(detail) } }];
    }
    return [{ type: "complete" }];
  }
  return [];
}

function toolTitle(name: string, input: unknown): string {
  const detail = record(input);
  for (const key of ["query", "url", "prompt"]) {
    const value = detail[key];
    if (typeof value === "string" && value.trim()) return `${name}: ${value.trim()}`;
  }
  return name;
}

function blocks(message: unknown): readonly Record<string, unknown>[] {
  const content = record(message).content;
  return Array.isArray(content) ? content.map(record) : [];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactScratchPath(text: string, cwd: string): string {
  if (!cwd) return text;
  const variants = new Set([cwd, cwd.replaceAll("\\", "/"), cwd.replaceAll("/", "\\")]);
  let redacted = text;
  for (const value of variants) {
    if (value) redacted = redacted.split(value).join("[workspace]");
  }
  return redacted;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

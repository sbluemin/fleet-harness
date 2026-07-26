import {
  UnifiedAgent,
  type AcpPermissionRequestParams,
  type AcpPermissionResponse,
  type IUnifiedAgentClient,
} from "@dotobokuri/core-unified-agent";

const DISPOSE_SETTLE_MS = 2_000;
const WEB_TOOL_NAMES = new Set(["websearch", "webfetch"]);

export const SCUTTLEBUTT_AGENT = {
  cliId: "claude",
  model: "sonnet",
  effort: "low",
} as const;

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
  Fleet, Fleet Console, Fleet CLI, a Theater, an Operation, a Carrier, or the
  stack any of them is built on, look it up there and answer from what you find.
  Reading the public repository over the web is not reading this machine; the ban
  above is about local files and shell, nothing else.
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

- Keep it short by default; a couple of hundred words is plenty for most things.
  Go longer only when the question genuinely earns it.
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
  readonly onEvent?: (event: ChatEvent) => void;
  readonly buildClient?: () => Promise<IUnifiedAgentClient>;
}

export interface ChatSessionLike {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  dispose(): Promise<void>;
}

export class ChatSession implements ChatSessionLike {
  private readonly options: ChatSessionOptions;
  private client: IUnifiedAgentClient | null = null;
  private pendingClient: IUnifiedAgentClient | null = null;
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
    const client = await (this.options.buildClient?.() ?? UnifiedAgent.build({ cli: SCUTTLEBUTT_AGENT.cliId }));
    this.pendingClient = client;
    if (this.disposed) {
      await client.disconnect().catch(() => undefined);
      if (this.pendingClient === client) this.pendingClient = null;
      throw new Error("Session disposed");
    }
    this.bridge(client);
    try {
      await client.connect({
        cwd: this.options.cwd,
        model: SCUTTLEBUTT_AGENT.model,
        effort: SCUTTLEBUTT_AGENT.effort,
        autoApprove: false,
        yoloMode: false,
        fsAccess: false,
        strictMcp: true,
        systemPrompt: ADMIRAL_SYSTEM_PROMPTS[this.options.admiral],
        systemPromptMode: "replace",
        mcpServers: [],
      });
    } catch (error) {
      if (this.disposed) await (this.disposeFlight ?? Promise.resolve());
      else await client.disconnect().catch(() => undefined);
      if (this.pendingClient === client) this.pendingClient = null;
      throw error;
    }
    if (this.disposed) {
      await (this.disposeFlight ?? Promise.resolve());
      throw new Error("Session disposed");
    }
    this.pendingClient = null;
    this.client = client;
    this.started = true;
  }

  send(text: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session disposed"));
    if (!this.started || !this.client) return Promise.reject(new Error("Session not started"));
    if (!text.trim()) return Promise.reject(new Error("Message required"));
    const run = this.turn.then(async () => {
      await this.client!.sendMessage(text);
    });
    this.turn = run.catch(() => undefined);
    return run;
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.disposed = true;
    this.disposeFlight = this.disposeResources();
    return this.disposeFlight;
  }

  private async disposeResources(): Promise<void> {
    const client = this.client ?? this.pendingClient;
    const cancel = client?.cancelPrompt().catch(() => undefined) ?? Promise.resolve();
    await settleWithin([cancel, this.turn.catch(() => undefined)], DISPOSE_SETTLE_MS);
    try {
      await client?.disconnect();
    } finally {
      if (this.client === client) this.client = null;
      if (this.pendingClient === client) this.pendingClient = null;
      this.started = false;
    }
  }

  private bridge(client: IUnifiedAgentClient): void {
    const redact = (text: string) => redactScratchPath(text, this.options.cwd);
    client.on("messageChunk", (text) => this.options.onEvent?.({ type: "chunk", text: redact(text) }));
    client.on("toolCall", (title, status) => this.options.onEvent?.({ type: "tool", title: redact(title), status: redact(status) }));
    client.on("toolCallUpdate", (title, status) => this.options.onEvent?.({ type: "tool", title: redact(title), status: redact(status) }));
    client.on("permissionRequest", (params, resolve) => resolveWebPermissionRequest(params, resolve));
    client.on("promptComplete", () => this.options.onEvent?.({ type: "complete" }));
    client.on("error", (error) => this.options.onEvent?.({
      type: "error",
      error: { code: "chat_error", message: redact(error.message) },
    }));
    client.on("exit", (code, signal) => this.options.onEvent?.({
      type: "error",
      error: {
        code: "chat_exited",
        message: redact(`Chat process exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`),
      },
    }));
  }
}

export function resolveWebPermissionRequest(
  params: AcpPermissionRequestParams,
  resolve: (response: AcpPermissionResponse) => void,
): void {
  const allowed = isWebToolPermission(params);
  const option = allowed
    ? params.options.find((candidate) => candidate.kind === "allow_once")
      ?? params.options.find((candidate) => candidate.kind === "allow_always")
    : params.options.find((candidate) => candidate.kind === "reject_once")
      ?? params.options.find((candidate) => candidate.kind === "reject_always");
  resolve(option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } });
}

export function isWebToolPermission(params: AcpPermissionRequestParams): boolean {
  const rawInput = record(params.toolCall.rawInput);
  const candidates: unknown[] = [
    params.toolCall.title,
    typeof params.toolCall.rawInput === "string" ? params.toolCall.rawInput : undefined,
    ...["toolName", "tool_name", "name", "title"].map((key) => rawInput[key]),
  ];
  if (candidates.some((candidate) => typeof candidate === "string" && isWebToolName(candidate))) return true;
  return isWebToolCall(params.toolCall.kind, rawInput);
}

/**
 * ACP 권한 요청은 도구 이름을 싣지 않는다 — Claude 브리지는 WebSearch를 검색어만 담은 title로,
 * WebFetch를 "Fetch <url>"로 바꿔 보낸다. 이름만 대조하면 웹 검색이 매번 거부되어 기능이 죽는다.
 * 브리지가 kind:"fetch"로 분류하는 도구는 이 둘뿐이고, 입력 모양까지 맞을 때만 허용해 범위를 좁힌다.
 */
export function isWebToolCall(kind: unknown, rawInput: Record<string, unknown>): boolean {
  if (kind !== "fetch") return false;
  return typeof rawInput.query === "string" || typeof rawInput.url === "string";
}

export function isWebToolName(value: string): boolean {
  let normalized = value.trim().toLowerCase();
  if (WEB_TOOL_NAMES.has(normalized)) return true;
  normalized = normalized.replace(/^mcp__/u, "");
  const segments = normalized.split(/__|[./:]/u).map((part) => part.trim()).filter(Boolean);
  return WEB_TOOL_NAMES.has(segments.at(-1) ?? "");
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

async function settleWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

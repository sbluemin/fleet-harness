import {
  UnifiedAgent,
  type AcpPermissionRequestParams,
  type AcpPermissionResponse,
  type CliType,
  type IUnifiedAgentClient,
} from "@dotobokuri/core-unified-agent";

const DISPOSE_SETTLE_MS = 2_000;
const WEB_TOOL_NAMES = new Set(["websearch", "webfetch"]);

export const SCUTTLEBUTT_SYSTEM_PROMPT = [
  "You are a read-only research assistant.",
  "You have no file-system access and must not read, write, edit, or execute local files or shell commands.",
  "Web search and web fetch are allowed when needed.",
  "Answer in concise Markdown and distinguish sourced facts from inference.",
].join(" ");

export type ChatEvent =
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

export interface ChatSessionOptions {
  readonly cliId: Extract<CliType, "claude" | "claude-kimi" | "codex">;
  readonly cwd: string;
  readonly model: string;
  readonly effort?: string;
  readonly onEvent?: (event: ChatEvent) => void;
  readonly buildClient?: (cliId: ChatSessionOptions["cliId"]) => Promise<IUnifiedAgentClient>;
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
    const client = await (this.options.buildClient?.(this.options.cliId) ?? UnifiedAgent.build({ cli: this.options.cliId }));
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
        model: this.options.model,
        effort: this.options.effort,
        autoApprove: false,
        yoloMode: false,
        fsAccess: false,
        strictMcp: this.options.cliId === "claude" || this.options.cliId === "claude-kimi",
        systemPrompt: SCUTTLEBUTT_SYSTEM_PROMPT,
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
  return candidates.some((candidate) => typeof candidate === "string" && isWebToolName(candidate));
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

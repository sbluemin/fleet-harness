import {
  createClaudeExecutionLoop,
  createClaudeGatewaySdk,
  type ClaudeExecutionEvent,
  type ClaudeExecutionLoop,
  type ClaudeExecutionUsage,
  type ClaudeGatewayEffort,
  type ClaudeGatewayMcpServer,
  type ClaudeGatewaySdk,
} from "@dotobokuri/core-agent/claude";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

/**
 * 기본 모델·강도. 사용자가 설정에서 고르지 않았을 때의 값이다. 구체 id가 아니라 별칭인 것이
 * 의도이고, 별칭은 자식이 보내기 전에 스스로 푼다 — 실측하면 `sonnet`이 와이어에서
 * `claude-sonnet-5`가 되므로 세대를 고정하지 않는다. 게이트웨이 카탈로그에 없는 별칭은 라우터가
 * 호출자 자격증명으로 Anthropic에 원문 중계한다. 즉 경로만 게이트웨이로 가고 과금처는 그대로다.
 */
export const SCUTTLEBUTT_AGENT = {
  model: "sonnet",
  effort: "low",
} as const;

/** 부관이 고를 수 있는 강도. 빠른 답이 일이라 xhigh·max는 두지 않는다. */
export const AIDE_EFFORTS = ["low", "medium", "high"] as const;
export type AideEffort = (typeof AIDE_EFFORTS)[number];

export function isAideEffort(value: unknown): value is AideEffort {
  return typeof value === "string" && (AIDE_EFFORTS as readonly string[]).includes(value);
}

/**
 * 펫이 가질 수 있는 툴 전부.
 *
 * `tools`가 내장 툴의 기본 집합을 이 둘로 잘라내므로 파일·셸 도구는 아예 존재하지 않게 된다.
 * `allowedTools`는 그 둘을 물어보지 않고 쓰게 하고, `dontAsk`는 그 밖의 무엇이든 승인을 기다리지
 * 않고 거부한다 — 헤드리스에서 승인 대기는 곧 멈춘 대화다. 세 값은 하나의 경계다.
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

You are Aide ${name}, ${species} of the Fleet Console — a small uniformed bird
who keeps station at the scuttlebutt, where the crew stops for water and quick
talk. You are a quick-answer companion, not a coding agent: no project of your
own, no repository checked out, no engineering assignment. You are who the crew
asks when they want an answer without leaving what they were doing.

# Who you are talking to

The person writing to you is the Admiral of the Navy — your commanding officer,
far above you. Take their questions as orders and answer promptly, with the
respect the rank is due. Writing in Korean, call them 대원수 — never
부관, which is your own rank and would put them at your level.

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
  capabilities. If asked what you are, answer as Aide ${name} in a sentence or two.
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
5. When you searched, end with one short "Sources:" line listing the pages you actually
   used, as plain URLs so the Admiral can open them.

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

/**
 * Console 언어에 맞춘 한 단락. 프롬프트 본문은 영어지만 호칭과 기본 답 언어는 사용자의 언어를
 * 따라야 한다 — "쓴 언어로 답하라"만으로는 짧은 영어 고유명사 질문이 영어 답으로 돌아온다.
 */
export function localeAddendum(locale: ConsoleLocale | undefined): string {
  if (locale === "ko") {
    return `# Console language

The Console is set to Korean. Answer in Korean unless the user clearly writes in another
language. Address the user as 대원수.`;
  }
  return `# Console language

The Console is set to English. Answer in English unless the user clearly writes in another
language.`;
}

export type ChatUsage = ClaudeExecutionUsage;

export type ChatEvent =
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "tool"; readonly title: string; readonly status: string; readonly url?: string }
  | { readonly type: "complete"; readonly usage?: ChatUsage }
  | { readonly type: "cancelled" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

export interface ChatSessionOptions {
  readonly cwd: string;
  readonly admiral: AdmiralId;
  /** 사용자가 고른 모델·강도. 없으면 기본값. */
  readonly model?: string;
  readonly effort?: AideEffort;
  readonly locale?: ConsoleLocale;
  /** Console이 서빙 중인 AI gateway의 절대 URL. 호스트만 아는 값이라 주입받는다. */
  readonly baseUrl: string;
  readonly onEvent?: (event: ChatEvent) => void;
  /**
   * 실험 "부관의 Console 읽기". 켜져 있을 때만 실린다 — 모델은 부관의 기본 모델 그대로이고, 읽기 도구가
   * 웹 검색 옆에 선다. 없으면 오늘과 완전히 같은 부관이다.
   */
  readonly consoleRead?: {
    readonly server: ClaudeGatewayMcpServer;
    readonly allowedTools: readonly string[];
    readonly promptAddendum: string;
  };
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
  /** 진행 중인 턴만 멈춘다. 세션은 살아 있어 다음 질문을 이어 받는다. */
  cancel(): void;
  dispose(): Promise<void>;
}

export class ChatSession implements ChatSessionLike {
  private readonly options: ChatSessionOptions;
  private readonly loop: ClaudeExecutionLoop;

  constructor(options: ChatSessionOptions) {
    this.options = { ...options };
    const redact = (value: string) => redactScratchPath(value, this.options.cwd);
    const consoleRead = this.options.consoleRead;
    const model = this.options.model ?? SCUTTLEBUTT_AGENT.model;
    const effort: ClaudeGatewayEffort = this.options.effort ?? SCUTTLEBUTT_AGENT.effort;
    const systemPrompt = [
      ADMIRAL_SYSTEM_PROMPTS[this.options.admiral],
      localeAddendum(this.options.locale),
      ...(consoleRead ? [consoleRead.promptAddendum] : []),
    ].join("\n\n");
    this.loop = createClaudeExecutionLoop({
      createSdk: () => {
        const create = { baseUrl: this.options.baseUrl, models: [model] };
        return this.options.createSdk?.(create) ?? createClaudeGatewaySdk(create);
      },
      buildTurn: () => ({
        model,
        effort,
        systemPrompt: { mode: "replace", text: systemPrompt },
        cwd: this.options.cwd,
        tools: [...PET_TOOLS],
        allowedTools: [...PET_TOOLS, ...(consoleRead?.allowedTools ?? [])],
        ...(consoleRead ? { mcpServers: { console: consoleRead.server } } : {}),
        permissionMode: "dontAsk",
        // 텍스트를 흘려 보내려면 부분 메시지가 필요하다. SSE `chunk` 계약이 그것으로 만들어진다.
        includePartialMessages: true,
      }),
      continuation: { kind: "resume-child" },
      settlement: { kind: "result" },
      onEvent: (event) => {
        for (const mapped of toChatEvents(event, redact)) this.options.onEvent?.(mapped);
      },
    });
  }

  start(): Promise<void> {
    return this.loop.start();
  }

  /**
   * 취소는 루프에 맡기고 클라이언트에는 `cancelled` 하나만 알린다 — 결과 이벤트가 없으니
   * `complete`가 오지 않고, 그대로 두면 카드가 "생각 중"에 굳는다.
   */
  cancel(): void {
    this.loop.cancel();
    this.options.onEvent?.({ type: "cancelled" });
  }

  send(text: string): Promise<void> {
    return this.loop.run(text).catch((error: unknown) => {
      if (!isLifecycleError(error)) {
        const redact = (value: string) => redactScratchPath(value, this.options.cwd);
        this.options.onEvent?.({
          type: "error",
          error: { code: "chat_error", message: redact(message(error)) },
        });
      }
      throw error;
    });
  }

  dispose(): Promise<void> {
    return this.loop.dispose();
  }
}

/**
 * 공통 실행 이벤트를 이 플러그인의 SSE 계약(chunk/tool/complete/error)으로 옮긴다.
 *
 * 텍스트만 흘린다. 사고는 같은 채널로 오지만 펫이 생각을 소리내어 말하게 되므로 버린다.
 * 도구 시작은 기존 제목 규칙을 쓰고, 끝은 디코더가 짝지은 이름(없으면 `tool`)을 쓴다.
 * 실패한 결과는 상세가 없으면 "Chat turn failed"다. 세션 id는 실리지 않는다.
 */
export function toChatEvents(
  event: ClaudeExecutionEvent,
  redact: (value: string) => string,
): readonly ChatEvent[] {
  if (event.kind === "text") return [{ type: "chunk", text: redact(event.text) }];
  if (event.kind === "thinking") return [];
  if (event.kind === "tool-start") {
    const url = toolUrl(event.input);
    return [{
      type: "tool",
      title: redact(toolTitle(event.name, event.input)),
      status: "running",
      ...(url === null ? {} : { url }),
    }];
  }
  if (event.kind === "tool-end") {
    return [{
      type: "tool",
      title: redact(event.name ?? "tool"),
      status: event.isError ? "error" : "done",
    }];
  }
  if (event.kind === "result") {
    if (event.isError) {
      return [{
        type: "error",
        error: { code: "chat_error", message: redact(event.detail ?? "Chat turn failed") },
      }];
    }
    return [{ type: "complete", ...(event.usage ? { usage: event.usage } : {}) }];
  }
  return [];
}

/** WebFetch의 `url`만 출처가 된다 — 검색 질의는 출처가 아니라 질문이다. */
function toolUrl(input: unknown): string | null {
  const value = record(input).url;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^https?:\/\//iu.test(trimmed) ? trimmed : null;
}

function toolTitle(name: string, input: unknown): string {
  const detail = record(input);
  for (const key of ["query", "url", "prompt"]) {
    const value = detail[key];
    if (typeof value === "string" && value.trim()) return `${name}: ${value.trim()}`;
  }
  return name;
}

function isLifecycleError(error: unknown): boolean {
  const text = message(error);
  return text === "Session disposed" || text === "Session not started" || text === "Message required";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactScratchPath(text: string, cwd: string): string {
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

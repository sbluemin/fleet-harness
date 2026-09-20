/**
 * Agent 실행 옵션의 형태와 정규화 — Fleet 공용 실행 정책이라 foundation이 소유한다.
 *
 * **저장은 소유하지 않는다.** 이 값들은 Console 설정 화면에서 고르는 것이라 그 Console
 * 인스턴스의 슬롯(`console/settings.json`)에 살고, 그 자리를 아는 것은 호스트뿐이다.
 * 한때 이 모듈이 `<Fleet 루트>/settings.json`을 직접 열었는데, 그 경로가 호스트의 유효
 * 루트를 거치지 않아 슬롯만 격리한 실행이 사용자의 진짜 파일에 `claudeCodeSkipPermissions`
 * 같은 값을 쓰는 누수가 있었다. 저장 자리는 주입으로만 건너온다.
 */

/**
 * What a new gateway session receives as its system prompt.
 *
 * - `on` — Claude Code's own base prompt, which is what a launch without any prompt flag
 *   already does. The key being absent means this.
 * - `append` — that base prompt followed by the user's own instructions.
 * - `off` — no base prompt. The user's instructions become the whole system prompt, and
 *   when there are none the session runs without one.
 *
 * `on` and `off` predate `append` and keep their stored meaning, so a settings file written
 * by an older Console needs no migration.
 */
export type ClaudeCodeSystemPromptMode = "on" | "append" | "off";

/**
 * Upper bound on the user's own system prompt, in characters. The same ceiling the launch
 * prompt carries: past it a caller is pasting a document, not writing an instruction, and
 * every turn of every session would pay for it.
 */
export const MAX_CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_CHARS = 16_000;

export interface AgentOptionsData {
  /** Idle agent auto-DORMANT threshold in minutes. `null` disables; key absent means server default. */
  readonly agentIdleDormantMinutes?: number | null;
  /**
   * Claude Code's own base system prompt for new gateway sessions. Key absent means `on`,
   * which is what a launch without any prompt flag already does.
   */
  readonly claudeCodeSystemPrompt?: ClaudeCodeSystemPromptMode;
  /**
   * The user's own system prompt, carried verbatim to both surfaces. Fleet writes nothing
   * into it — this is the user's text, and the only reason it lives here is that the user
   * asked for it to reach every new session.
   *
   * Key absent means there is none, so `append` falls back to the base prompt alone and
   * `off` runs without a system prompt.
   */
  readonly claudeCodeCustomSystemPrompt?: string;
  /**
   * Whether Fleet launches Claude Code with its permission gate skipped. Key absent means
   * `false`: the child boots on its own default and asks before each tool. Turning this on is
   * an explicit user choice and only the surfaces that can actually show a prompt carry it —
   * the terminal and the `fleet` launcher. Chat keeps bypass regardless, because that surface
   * has no permission gate of its own to honour the choice with.
   */
  readonly claudeCodeSkipPermissions?: boolean;
  /**
   * Claude Code built-in subagents the user opted out of, by agent name (`Explore`, `Plan`,
   * ...). Key absent or empty means every built-in stays available, which is what a launch
   * without any rule already does. Fleet reads the live roster from the installed CLI, so
   * this list is an opt-out overlay, not a catalog: a name that no longer exists is inert.
   */
  readonly claudeCodeDisabledAgents?: readonly string[];
}

/**
 * 저장 자리를 향한 포트. 호스트가 자기 슬롯에 붙인 구현을 주입한다 — 이 모듈은 그 구현이
 * 어떤 파일을 여는지 알지 못한다.
 */
export interface AgentOptionsService {
  readonly load: () => AgentOptionsData;
  readonly update: (mutate: (current: AgentOptionsData) => AgentOptionsData) => AgentOptionsData;
}

export interface AgentOptionsValidationResult {
  readonly data: AgentOptionsData;
  readonly changed: boolean;
}

export function sanitizeAgentOptionsData(value: unknown): AgentOptionsValidationResult {
  if (!isRecord(value)) return { data: {}, changed: true };

  const agentIdleDormantMinutes = sanitizeAgentIdleDormantMinutes(value.agentIdleDormantMinutes);
  const claudeCodeSystemPrompt = sanitizeClaudeCodeSystemPrompt(value.claudeCodeSystemPrompt);
  const claudeCodeCustomSystemPrompt = sanitizeClaudeCodeCustomSystemPrompt(value.claudeCodeCustomSystemPrompt);
  const claudeCodeSkipPermissions = sanitizeClaudeCodeSkipPermissions(value.claudeCodeSkipPermissions);
  const claudeCodeDisabledAgents = sanitizeClaudeCodeDisabledAgents(value.claudeCodeDisabledAgents);
  const data: AgentOptionsData = {
    ...(agentIdleDormantMinutes !== undefined ? { agentIdleDormantMinutes } : {}),
    ...(claudeCodeSystemPrompt !== undefined ? { claudeCodeSystemPrompt } : {}),
    ...(claudeCodeCustomSystemPrompt !== undefined ? { claudeCodeCustomSystemPrompt } : {}),
    ...(claudeCodeSkipPermissions !== undefined ? { claudeCodeSkipPermissions } : {}),
    ...(claudeCodeDisabledAgents !== undefined ? { claudeCodeDisabledAgents } : {}),
  };
  const allowedKeys = new Set([
    "agentIdleDormantMinutes",
    "claudeCodeSystemPrompt",
    "claudeCodeCustomSystemPrompt",
    "claudeCodeSkipPermissions",
    "claudeCodeDisabledAgents",
  ]);
  const changed = Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    ("agentIdleDormantMinutes" in value && agentIdleDormantMinutes === undefined) ||
    ("claudeCodeSystemPrompt" in value && claudeCodeSystemPrompt === undefined) ||
    ("claudeCodeCustomSystemPrompt" in value && claudeCodeCustomSystemPrompt !== value.claudeCodeCustomSystemPrompt) ||
    ("claudeCodeSkipPermissions" in value && claudeCodeSkipPermissions === undefined) ||
    ("claudeCodeDisabledAgents" in value && !sameStringList(value.claudeCodeDisabledAgents, claudeCodeDisabledAgents));

  return { data, changed };
}

function sanitizeAgentIdleDormantMinutes(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0) return value;
  return undefined;
}

function sanitizeClaudeCodeSystemPrompt(value: unknown): ClaudeCodeSystemPromptMode | undefined {
  return value === "on" || value === "append" || value === "off" ? value : undefined;
}

/**
 * The user's text survives as written, minus the characters that would break the surfaces
 * carrying it: this body travels as an argv file on one surface and a JSON option on the
 * other, so NUL and the other C0 controls go, while newlines and tabs stay — they are the
 * instruction's own shape.
 *
 * A body past the ceiling drops the key rather than being silently truncated: half an
 * instruction is a different instruction. The route refuses it before it ever reaches here.
 */
export function sanitizeClaudeCodeCustomSystemPrompt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > MAX_CLAUDE_CODE_CUSTOM_SYSTEM_PROMPT_CHARS ? undefined : normalized;
}

/**
 * Only a real boolean survives. A truthy string from a hand-edited file must not read as
 * consent to skip the permission gate, so anything else drops the key back to the default.
 */
function sanitizeClaudeCodeSkipPermissions(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Only well-formed agent names survive: a non-empty string without whitespace or the
 * `Agent(...)` rule delimiters, since each entry becomes one `Agent(<name>)` deny rule.
 * Duplicates collapse and an empty result drops the key back to "all enabled".
 */
export function sanitizeClaudeCodeDisabledAgents(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name.length === 0 || name.length > 128 || !/^[^\s()]+$/.test(name)) continue;
    names.add(name);
  }
  return names.size > 0 ? [...names] : undefined;
}

function sameStringList(raw: unknown, sanitized: readonly string[] | undefined): boolean {
  if (!Array.isArray(raw)) return false;
  if (sanitized === undefined) return raw.length === 0;
  return raw.length === sanitized.length && raw.every((entry, index) => entry === sanitized[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { CarrierJobStreamEvent } from "@dotobokuri/fleet-carriers";

import type { CliMessagePolicy } from "../agent-cli/types.js";

export interface PtyWriteSink {
  write(data: string): void;
}

const DEFAULT_BRACKETED_PASTE = false;
const DEFAULT_LINE_TERMINATOR = "\r";
const DEFAULT_MULTILINE_STRATEGY = "literal";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const C1_BRACKETED_PASTE_END = "\x9B201~";
const CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;
const LINE_BREAK_PATTERN = /[\r\n]/;

export function createCarrierResultReminderRouter(deps: {
  readonly streamRegister: (handler: (event: CarrierJobStreamEvent) => void) => () => void;
  readonly resolveSink: (event: CarrierJobStreamEvent) => PtyWriteSink | undefined;
  readonly resolvePolicy?: (event: CarrierJobStreamEvent) => CliMessagePolicy;
}): () => void {
  return deps.streamRegister((event) => {
    if (event.type !== "job:finalized") return;
    if (typeof event.systemReminder !== "string") return;

    const reminder = sanitizeCarrierResultReminder(event.systemReminder);
    if (reminder.trim().length === 0) return;

    const sink = deps.resolveSink(event);
    if (!sink) return;

    // host가 활성 프로파일의 messagePolicy를 제공하면 그대로 적용한다. 미제공 시 기본 정책.
    const policy = deps.resolvePolicy?.(event) ?? {};
    for (const chunk of formatCarrierResultReminderMessage(policy, reminder)) {
      sink.write(chunk);
    }
  });
}

export function sanitizeCarrierResultReminder(text: string): string {
  return text
    .split(BRACKETED_PASTE_END)
    .join("")
    .split(C1_BRACKETED_PASTE_END)
    .join("")
    .replace(CONTROL_CHARS_EXCEPT_INPUT_WHITESPACE, "");
}

export function formatCarrierResultReminderMessage(
  policy: CliMessagePolicy,
  text: string,
): string[] {
  const resolvedPolicy = resolveMessagePolicy(policy);
  return [applyMessagePolicy(text, resolvedPolicy)];
}

function resolveMessagePolicy(policy: CliMessagePolicy): Required<CliMessagePolicy> {
  return {
    bracketedPaste: policy.bracketedPaste ?? DEFAULT_BRACKETED_PASTE,
    lineTerminator: policy.lineTerminator ?? DEFAULT_LINE_TERMINATOR,
    multilineStrategy: policy.multilineStrategy ?? DEFAULT_MULTILINE_STRATEGY,
  };
}

function applyMessagePolicy(text: string, policy: Required<CliMessagePolicy>): string {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));
  const body = usePasteMode ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;

  // paste 블록과 제출 종결자(CR)를 반드시 하나의 PTY write로 내보낸다. 둘을 별도 write로
  // 쪼개면 Windows ConPTY의 Codex TUI가 뒤따르는 CR을 Enter로 인식하지 못해, 붙여넣은
  // 리마인더가 프롬프트에 남고 제출되지 않는다. 단일 원자적 write는 하나의 입력 레코드로
  // 전달되어 안정적으로 제출되며, macOS/유닉스 PTY 동작에는 영향이 없다.
  return `${body}${policy.lineTerminator}`;
}

import type { PtyHost } from "../types.js";

export interface ProgrammaticInputProfile {
  readonly messagePolicy?: CliMessagePolicy;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface ProgrammaticInput {
  readonly sendMessage: (
    text: string,
    opts?: {
      readonly bracketedPaste?: boolean;
      readonly lineTerminator?: string;
      readonly multilineStrategy?: "literal" | "paste-mode";
    },
  ) => void;
  readonly sendKeys: (data: string) => void;
  readonly sendCommand: (line: string) => void;
}

const DEFAULT_BRACKETED_PASTE = false;
const DEFAULT_LINE_TERMINATOR = "\r";
const DEFAULT_MULTILINE_STRATEGY = "literal";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const LINE_BREAK_PATTERN = /[\r\n]/;

export function createProgrammaticInput(ptyHost: PtyHost, profile: ProgrammaticInputProfile): ProgrammaticInput {
  return {
    sendMessage(text, opts) {
      const policy = resolvePolicy(profile, opts);
      ptyHost.write(applyMessagePolicy(text, policy));
    },

    sendKeys(data) {
      ptyHost.write(data);
    },

    sendCommand(line) {
      assertSingleLineCommand(line);
      const policy = resolvePolicy(profile);
      ptyHost.write(applyMessagePolicy(line, policy));
    },
  };
}

function resolvePolicy(
  profile: ProgrammaticInputProfile,
  opts: {
    readonly bracketedPaste?: boolean;
    readonly lineTerminator?: string;
    readonly multilineStrategy?: "literal" | "paste-mode";
  } = {},
): Required<CliMessagePolicy> {
  return {
    bracketedPaste: opts.bracketedPaste ?? profile.messagePolicy?.bracketedPaste ?? DEFAULT_BRACKETED_PASTE,
    lineTerminator: opts.lineTerminator ?? profile.messagePolicy?.lineTerminator ?? DEFAULT_LINE_TERMINATOR,
    multilineStrategy: opts.multilineStrategy ?? profile.messagePolicy?.multilineStrategy ?? DEFAULT_MULTILINE_STRATEGY,
  };
}

function applyMessagePolicy(text: string, policy: Required<CliMessagePolicy>): string {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));
  const body = usePasteMode ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}` : text;

  // paste 블록과 제출 종결자(CR)를 반드시 하나의 PTY write로 내보낸다. 둘을 별도 write로
  // 쪼개면 Windows ConPTY의 Codex TUI가 뒤따르는 CR을 Enter로 인식하지 못해, 붙여넣은
  // 텍스트가 프롬프트에 남고 제출되지 않는다. 단일 원자적 write는 하나의 입력 레코드로
  // 전달되어 안정적으로 제출되며, macOS/유닉스 PTY 동작에는 영향이 없다.
  return `${body}${policy.lineTerminator}`;
}

function assertSingleLineCommand(line: string): void {
  if (LINE_BREAK_PATTERN.test(line)) {
    throw new Error("Programmatic command must be a single line.");
  }
}

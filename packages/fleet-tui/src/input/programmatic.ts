import type { PtyHost } from "../pty/dedicated/types.js";

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

interface AppliedMessagePolicy {
  readonly payload: string;
  readonly submit?: string;
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
      const appliedPolicy = applyMessagePolicy(text, policy);
      writeAppliedMessagePolicy(ptyHost, appliedPolicy);
    },

    sendKeys(data) {
      ptyHost.write(data);
    },

    sendCommand(line) {
      assertSingleLineCommand(line);
      const policy = resolvePolicy(profile);
      const appliedPolicy = applyMessagePolicy(line, policy);
      writeAppliedMessagePolicy(ptyHost, appliedPolicy);
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

function applyMessagePolicy(
  text: string,
  policy: Required<CliMessagePolicy>,
): AppliedMessagePolicy {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));

  if (!usePasteMode) {
    return { payload: `${text}${policy.lineTerminator}` };
  }

  return {
    payload: `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
    submit: policy.lineTerminator,
  };
}

function writeAppliedMessagePolicy(ptyHost: PtyHost, appliedPolicy: AppliedMessagePolicy): void {
  ptyHost.write(appliedPolicy.payload);

  if (appliedPolicy.submit !== undefined && appliedPolicy.submit.length > 0) {
    ptyHost.write(appliedPolicy.submit);
  }
}

function assertSingleLineCommand(line: string): void {
  if (LINE_BREAK_PATTERN.test(line)) {
    throw new Error("Programmatic command must be a single line.");
  }
}

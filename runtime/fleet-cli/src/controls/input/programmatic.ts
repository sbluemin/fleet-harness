import type { PtyInputChunk } from "@dotobokuri/fleet-admiral";

import type { PtyHost } from "../types.js";

export interface ProgrammaticInputProfile {
  readonly messagePolicy?: CliMessagePolicy;
}

export interface CliMessagePolicy {
  readonly bracketedPaste?: boolean;
  readonly conptyPasteBurst?: boolean;
  readonly lineTerminator?: string;
  readonly multilineStrategy?: "literal" | "paste-mode";
}

export interface ProgrammaticInput {
  readonly sendMessage: (
    text: string,
    opts?: {
      readonly bracketedPaste?: boolean;
      readonly conptyPasteBurst?: boolean;
      readonly lineTerminator?: string;
      readonly multilineStrategy?: "literal" | "paste-mode";
    },
  ) => void;
  readonly sendKeys: (data: string) => void;
  readonly sendCommand: (line: string) => void;
}

const DEFAULT_BRACKETED_PASTE = false;
const DEFAULT_CONPTY_PASTE_BURST = false;
const DEFAULT_LINE_TERMINATOR = "\r";
const DEFAULT_MULTILINE_STRATEGY = "literal";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const LINE_BREAK_PATTERN = /[\r\n]/;
// Windows crossterm reads INPUT_RECORD rather than bracketed paste, then Codex suppresses Enter during its paste burst window.
const WINDOWS_CONPTY_SUBMIT_DELAY_MS = 250;

export function createProgrammaticInput(
  ptyHost: PtyHost,
  profile: ProgrammaticInputProfile,
  platform: NodeJS.Platform = process.platform,
): ProgrammaticInput {
  return {
    sendMessage(text, opts) {
      writeChunksWithDelay((data) => ptyHost.write(data), formatProgrammaticInputMessage(resolvePolicy(profile, opts), text, platform));
    },

    sendKeys(data) {
      ptyHost.write(data);
    },

    sendCommand(line) {
      assertSingleLineCommand(line);
      writeChunksWithDelay((data) => ptyHost.write(data), formatProgrammaticInputMessage(resolvePolicy(profile), line, platform));
    },
  };
}

function resolvePolicy(
  profile: ProgrammaticInputProfile,
  opts: {
    readonly bracketedPaste?: boolean;
    readonly conptyPasteBurst?: boolean;
    readonly lineTerminator?: string;
    readonly multilineStrategy?: "literal" | "paste-mode";
  } = {},
): Required<CliMessagePolicy> {
  return {
    bracketedPaste: opts.bracketedPaste ?? profile.messagePolicy?.bracketedPaste ?? DEFAULT_BRACKETED_PASTE,
    conptyPasteBurst: opts.conptyPasteBurst ?? profile.messagePolicy?.conptyPasteBurst ?? DEFAULT_CONPTY_PASTE_BURST,
    lineTerminator: opts.lineTerminator ?? profile.messagePolicy?.lineTerminator ?? DEFAULT_LINE_TERMINATOR,
    multilineStrategy: opts.multilineStrategy ?? profile.messagePolicy?.multilineStrategy ?? DEFAULT_MULTILINE_STRATEGY,
  };
}

export function formatProgrammaticInputMessage(
  policy: Required<CliMessagePolicy>,
  text: string,
  platform: NodeJS.Platform = process.platform,
): PtyInputChunk[] {
  return applyMessagePolicy(text, policy, platform);
}

function applyMessagePolicy(
  text: string,
  policy: Required<CliMessagePolicy>,
  platform: NodeJS.Platform,
): PtyInputChunk[] {
  const usePasteMode = policy.bracketedPaste || (policy.multilineStrategy === "paste-mode" && LINE_BREAK_PATTERN.test(text));

  if (policy.conptyPasteBurst && platform === "win32" && usePasteMode) {
    return [
      { data: text },
      { data: policy.lineTerminator, submitDelayMs: WINDOWS_CONPTY_SUBMIT_DELAY_MS },
    ];
  }

  return [{
    data: usePasteMode
      ? `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}${policy.lineTerminator}`
      : `${text}${policy.lineTerminator}`,
  }];
}

function writeChunksWithDelay(write: (data: string) => void, chunks: readonly PtyInputChunk[]): void {
  let index = 0;

  const writeNext = (): void => {
    const chunk = chunks[index++];
    if (!chunk) return;

    const commit = () => {
      try {
        write(chunk.data);
      } catch {
        // Sessions may close before a deferred submit reaches the host PTY.
      }
      writeNext();
    };

    if (chunk.submitDelayMs === undefined) {
      commit();
    } else {
      setTimeout(commit, chunk.submitDelayMs);
    }
  };

  writeNext();
}

function assertSingleLineCommand(line: string): void {
  if (LINE_BREAK_PATTERN.test(line)) {
    throw new Error("Programmatic command must be a single line.");
  }
}

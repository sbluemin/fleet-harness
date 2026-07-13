import { describe, expect, it, vi } from "vitest";

import {
  createCarrierResultReminderRouter,
  formatCarrierResultReminderMessage,
  type CliMessagePolicy,
} from "@dotobokuri/fleet-admiral";

import { createProgrammaticInput, type PtyHost } from "../src/controls/index.js";
import { formatProgrammaticInputMessage, type CliMessagePolicy as ProgrammaticCliMessagePolicy } from "../src/controls/input/programmatic.js";

describe("carrier reminder encoding parity", () => {
  it("matches programmatic input chunks for bracketed paste profiles", () => {
    const policy: CliMessagePolicy = {
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    };
    const text = "<system-reminder>\n[carrier:result]\nready\n</system-reminder>";

    expect(formatCarrierResultReminderMessage(policy, text, "darwin")).toEqual(formatProgrammaticMessage(policy, text, "darwin"));
  });

  it("matches programmatic input chunks for paste-mode multiline profiles", () => {
    const policy: CliMessagePolicy = {
      lineTerminator: "\n",
      multilineStrategy: "paste-mode",
    };
    const text = "line 1\nline 2";

    expect(formatCarrierResultReminderMessage(policy, text, "darwin")).toEqual(formatProgrammaticMessage(policy, text, "darwin"));
  });

  it("matches programmatic input chunks for literal single-line profiles", () => {
    const policy: CliMessagePolicy = {
      lineTerminator: "\r",
      multilineStrategy: "literal",
    };
    const text = "single line";

    expect(formatCarrierResultReminderMessage(policy, text, "darwin")).toEqual(formatProgrammaticMessage(policy, text, "darwin"));
  });

  it("matches Windows ConPTY paste-burst chunks", () => {
    const policy: CliMessagePolicy = {
      bracketedPaste: true,
      conptyPasteBurst: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    };
    const text = "line 1\nline 2";

    expect(formatCarrierResultReminderMessage(policy, text, "win32")).toEqual(formatProgrammaticMessage(policy, text, "win32"));
  });

  it("delays programmatic Windows ConPTY submission", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const policy: CliMessagePolicy = {
        bracketedPaste: true,
        conptyPasteBurst: true,
        lineTerminator: "\r",
        multilineStrategy: "paste-mode",
      };

      createProgrammaticInput(createWriteOnlyPtyHost(writes), { messagePolicy: policy }, "win32").sendMessage("line 1\nline 2");

      expect(writes).toEqual(["line 1\nline 2"]);
      vi.advanceTimersByTime(250);
      expect(writes).toEqual(["line 1\nline 2", "\r"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes encoded chunks through the two-pane sink", () => {
    const twoPaneWrites: string[] = [];
    const policy: CliMessagePolicy = {
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    };
    const event = {
      finishedAt: 1,
      jobId: "job:test",
      status: "done" as const,
      summary: "done",
      systemReminder: "alpha\nbeta",
      type: "job:finalized" as const,
    };
    const expected = writeProgrammaticMessage(policy, event.systemReminder);

    const disposeTwoPane = createCarrierResultReminderRouter({
      streamRegister(handler) {
        handler(event);
        return () => undefined;
      },
      resolveSink: () => ({
        write: (data) => twoPaneWrites.push(data),
      }),
      resolvePolicy: () => policy,
    });
    expect(twoPaneWrites).toEqual(expected);
    disposeTwoPane();
  });
});

function formatProgrammaticMessage(policy: CliMessagePolicy, text: string, platform: NodeJS.Platform) {
  return formatProgrammaticInputMessage(resolveProgrammaticPolicy(policy), text, platform);
}

function writeProgrammaticMessage(policy: CliMessagePolicy, text: string): string[] {
  const writes: string[] = [];
  createProgrammaticInput(createWriteOnlyPtyHost(writes), { messagePolicy: policy }).sendMessage(text);
  return writes;
}

function resolveProgrammaticPolicy(policy: CliMessagePolicy): Required<ProgrammaticCliMessagePolicy> {
  return {
    bracketedPaste: policy.bracketedPaste ?? false,
    conptyPasteBurst: policy.conptyPasteBurst ?? false,
    lineTerminator: policy.lineTerminator ?? "\r",
    multilineStrategy: policy.multilineStrategy ?? "literal",
  };
}

function createWriteOnlyPtyHost(writes: string[]): PtyHost {
  return {
    getKeyboardProtocol: undefined,
    getMouseProtocol: undefined,
    kill: () => undefined,
    onData: () => undefined,
    onExit: () => undefined,
    resize: () => undefined,
    start: () => undefined,
    write: (data) => writes.push(data),
  };
}

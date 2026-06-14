import { describe, expect, it } from "vitest";

import {
  createCarrierResultReminderRouter,
  formatCarrierResultReminderMessage,
  type CliMessagePolicy,
} from "@dotobokuri/fleet-admiral";

import { createProgrammaticInput, type PtyHost } from "../src/controls/index.js";

describe("carrier reminder encoding parity", () => {
  it("matches legacy programmatic input chunks for bracketed paste profiles", () => {
    const policy: CliMessagePolicy = {
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    };
    const text = "<system-reminder>\n[carrier:result]\nready\n</system-reminder>";

    expect(formatCarrierResultReminderMessage(policy, text)).toEqual(writeLegacyProgrammaticMessage(policy, text));
  });

  it("matches legacy programmatic input chunks for paste-mode multiline profiles", () => {
    const policy: CliMessagePolicy = {
      lineTerminator: "\n",
      multilineStrategy: "paste-mode",
    };
    const text = "line 1\nline 2";

    expect(formatCarrierResultReminderMessage(policy, text)).toEqual(writeLegacyProgrammaticMessage(policy, text));
  });

  it("matches legacy programmatic input chunks for literal single-line profiles", () => {
    const policy: CliMessagePolicy = {
      lineTerminator: "\r",
      multilineStrategy: "literal",
    };
    const text = "single line";

    expect(formatCarrierResultReminderMessage(policy, text)).toEqual(writeLegacyProgrammaticMessage(policy, text));
  });

  it("writes equivalent chunks through 2-pane and native sinks", () => {
    const twoPaneWrites: string[] = [];
    const nativeWrites: string[] = [];
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
    const expected = writeLegacyProgrammaticMessage(policy, event.systemReminder);

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
    const disposeNative = createCarrierResultReminderRouter({
      streamRegister(handler) {
        handler(event);
        return () => undefined;
      },
      resolveSink: () => ({
        write: (data) => nativeWrites.push(data),
      }),
      resolvePolicy: () => policy,
    });

    expect(twoPaneWrites).toEqual(expected);
    expect(nativeWrites).toEqual(expected);
    disposeTwoPane();
    disposeNative();
  });
});

function writeLegacyProgrammaticMessage(policy: CliMessagePolicy, text: string): string[] {
  const writes: string[] = [];
  createProgrammaticInput(createWriteOnlyPtyHost(writes), { messagePolicy: policy }).sendMessage(text);
  return writes;
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

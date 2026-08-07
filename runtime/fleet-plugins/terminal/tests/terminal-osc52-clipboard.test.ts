import { describe, expect, it, vi } from "vitest";

import { OSC_CLIPBOARD_IDENT, createTerminalOsc52Clipboard, parseOsc52ClipboardWrite } from "../client/shared/terminal-osc52-clipboard.js";

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("parseOsc52ClipboardWrite", () => {
  it("decodes a clipboard write targeted at the system clipboard", () => {
    expect(parseOsc52ClipboardWrite(`c;${base64("copied from the TUI")}`)).toBe("copied from the TUI");
  });

  it("decodes multi-byte text as UTF-8", () => {
    expect(parseOsc52ClipboardWrite(`c;${base64("복사된 텍스트 · ✳")}`)).toBe("복사된 텍스트 · ✳");
  });

  it("accepts a clipboard target listed alongside other buffers", () => {
    expect(parseOsc52ClipboardWrite(`pc;${base64("both")}`)).toBe("both");
  });

  it("refuses a read query so the clipboard is never handed back to the process", () => {
    expect(parseOsc52ClipboardWrite("c;?")).toBeNull();
  });

  it("ignores targets that have no browser counterpart", () => {
    expect(parseOsc52ClipboardWrite(`p;${base64("primary selection")}`)).toBeNull();
    expect(parseOsc52ClipboardWrite(`s0;${base64("cut buffer")}`)).toBeNull();
  });

  it("ignores an empty payload rather than clearing the clipboard", () => {
    expect(parseOsc52ClipboardWrite("c;")).toBeNull();
  });

  it("ignores a malformed sequence", () => {
    expect(parseOsc52ClipboardWrite("c")).toBeNull();
    expect(parseOsc52ClipboardWrite("c;not base64!!")).toBeNull();
  });

  it("tolerates whitespace inside the payload", () => {
    const padded = `${base64("wrapped payload").slice(0, 4)} ${base64("wrapped payload").slice(4)}`;
    expect(parseOsc52ClipboardWrite(`c;${padded}`)).toBe("wrapped payload");
  });
});

describe("createTerminalOsc52Clipboard", () => {
  it("registers on the OSC 52 identifier and writes decoded text to the clipboard", () => {
    const harness = createHarness();

    expect(harness.registeredIdent).toBe(OSC_CLIPBOARD_IDENT);
    expect(harness.emit(`c;${base64("selection from the app")}`)).toBe(true);
    expect(harness.writeText).toHaveBeenCalledTimes(1);
    expect(harness.writeText).toHaveBeenCalledWith("selection from the app");
  });

  it("consumes a read query without writing or answering it", () => {
    const harness = createHarness();

    expect(harness.emit("c;?")).toBe(true);
    expect(harness.writeText).not.toHaveBeenCalled();
  });

  it("survives a rejected clipboard write", () => {
    const harness = createHarness(() => Promise.reject(new Error("clipboard blocked")));

    expect(() => harness.emit(`c;${base64("blocked")}`)).not.toThrow();
  });

  it("stays inert without a clipboard", () => {
    const registeredHandlers: Array<(data: string) => boolean> = [];
    const controller = createTerminalOsc52Clipboard({
      parser: {
        registerOscHandler: (_ident, callback) => {
          registeredHandlers.push(callback);
          return { dispose: () => undefined };
        },
      },
    });

    expect(registeredHandlers[0]?.(`c;${base64("no clipboard")}`)).toBe(true);
    controller.dispose();
  });

  it("releases its handler on dispose", () => {
    const harness = createHarness();

    harness.controller.dispose();

    expect(harness.disposeHandler).toHaveBeenCalledTimes(1);
  });
});

function createHarness(writeImplementation: (text: string) => Promise<void> = () => Promise.resolve()) {
  const writeText = vi.fn(writeImplementation);
  const disposeHandler = vi.fn();
  let registeredIdent: number | null = null;
  let handler: ((data: string) => boolean) | null = null;

  const controller = createTerminalOsc52Clipboard({
    parser: {
      registerOscHandler: (ident, callback) => {
        registeredIdent = ident;
        handler = callback;
        return { dispose: disposeHandler };
      },
    },
    clipboard: { writeText },
  });

  return {
    controller,
    disposeHandler,
    writeText,
    get registeredIdent() {
      return registeredIdent;
    },
    emit: (data: string) => handler!(data),
  };
}

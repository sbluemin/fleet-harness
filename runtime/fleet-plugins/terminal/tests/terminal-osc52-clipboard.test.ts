import { describe, expect, it, vi } from "vitest";

import { OSC_CLIPBOARD_IDENT, createTerminalOsc52Clipboard, parseOsc52ClipboardWrite } from "../client/shared/terminal-osc52-clipboard.js";

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe("parseOsc52ClipboardWrite", () => {
  it("decodes a clipboard write targeted at the system clipboard", () => {
    expect(parseOsc52ClipboardWrite(`c;${base64("copied from the TUI")}`)).toBe("copied from the TUI");
  });

  it("refuses a read query so the clipboard is never handed back to the process", () => {
    expect(parseOsc52ClipboardWrite("c;?")).toBeNull();
  });
});

describe("createTerminalOsc52Clipboard", () => {

  it("does not overwrite the clipboard with a copy replayed from scrollback", () => {
    let replaying = true;
    const harness = createHarness(() => Promise.resolve(), () => replaying);

    // Reopening a panel replays every past chunk, including the OSC 52 of a copy made long ago.
    expect(harness.emit(`c;${base64("copied an hour ago")}`)).toBe(true);
    expect(harness.writeText).not.toHaveBeenCalled();

    replaying = false;
    harness.emit(`c;${base64("copied just now")}`);

    expect(harness.writeText).toHaveBeenCalledTimes(1);
    expect(harness.writeText).toHaveBeenCalledWith("copied just now");
  });
});

function createHarness(
  writeImplementation: (text: string) => Promise<void> = () => Promise.resolve(),
  isReplayingScrollback?: () => boolean,
) {
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
    ...(isReplayingScrollback ? { isReplayingScrollback } : {}),
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

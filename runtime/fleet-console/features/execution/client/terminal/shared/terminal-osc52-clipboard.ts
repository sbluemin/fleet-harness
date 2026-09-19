interface Disposable {
  readonly dispose: () => void;
}

interface OscHandlerRegistrar {
  readonly registerOscHandler: (ident: number, callback: (data: string) => boolean) => Disposable;
}

interface ClipboardWriter {
  readonly writeText: (text: string) => Promise<void>;
}

export interface TerminalOsc52ClipboardOptions {
  readonly parser: OscHandlerRegistrar;
  readonly clipboard?: ClipboardWriter;
  /**
   * True while the connection is replaying server-held scrollback. Replayed bytes are a transcript
   * of copies the user already made, so re-applying them would overwrite the current clipboard with
   * stale content just by reopening a panel or reconnecting.
   */
  readonly isReplayingScrollback?: () => boolean;
}

export interface TerminalOsc52ClipboardController {
  readonly dispose: () => void;
}

// OSC 52 is the only way a full-screen TUI can put text on the clipboard: once it enables mouse
// tracking, xterm hands every drag to the application and disables its own selection, so the
// application draws the selection itself and reports the copy over this sequence.
export const OSC_CLIPBOARD_IDENT = 52;

/**
 * Applies OSC 52 clipboard writes emitted by the running terminal application.
 *
 * Writes only. A read query (`OSC 52 ; c ; ?`) asks the terminal to hand the user's clipboard
 * back to the process on stdin; that answer is never sent, so a program running in a panel
 * cannot exfiltrate clipboard contents it did not put there.
 */
export function createTerminalOsc52Clipboard({
  parser,
  clipboard,
  isReplayingScrollback,
}: TerminalOsc52ClipboardOptions): TerminalOsc52ClipboardController {
  const subscription = parser.registerOscHandler(OSC_CLIPBOARD_IDENT, (data) => {
    const text = parseOsc52ClipboardWrite(data);
    // Returning true keeps the sequence consumed either way — an unhandled OSC 52 would otherwise
    // be logged as unknown on every copy, and refusing a read query or a replayed copy is still
    // handling it.
    if (text === null || !clipboard || isReplayingScrollback?.() === true) return true;
    try {
      void clipboard.writeText(text).catch(() => undefined);
    } catch {
      // Clipboard access is best-effort; a blocked write must not break terminal output parsing.
    }
    return true;
  });

  return { dispose: () => subscription.dispose() };
}

/**
 * Returns the text an `OSC 52 ; Pc ; Pd` sequence asks to place on the clipboard, or null when the
 * sequence is not a clipboard write this surface applies.
 */
export function parseOsc52ClipboardWrite(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator === -1) return null;

  // Pc selects the target buffers. Only `c` is the system clipboard; primary/secondary/select and
  // the cut buffers are X11 concepts a browser has no counterpart for, so they are left alone.
  if (!data.slice(0, separator).includes("c")) return null;

  // Pd is `?` for a read query, base64 for a write. Whitespace is not part of the payload.
  const payload = data.slice(separator + 1).replace(/\s+/g, "");
  if (payload === "" || payload === "?") return null;

  const text = decodeBase64Utf8(payload);
  return text === null || text === "" ? null : text;
}

function decodeBase64Utf8(payload: string): string | null {
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    // atob yields one byte per code unit, so multi-byte text has to be decoded as UTF-8 —
    // reading it as latin1 mangles every non-ASCII selection.
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

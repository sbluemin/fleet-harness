export type TerminalMouseProtocol = "none" | "x10" | "vt200" | "drag" | "any";
export type TerminalMouseEncoding = "default" | "sgr" | "sgr-pixels";

export interface TerminalModeSnapshot {
  readonly alternateScreenActive: boolean;
  readonly mouseProtocol: TerminalMouseProtocol;
  readonly mouseEncoding: TerminalMouseEncoding;
}

export interface TerminalModeTracker {
  readonly push: (data: Uint8Array) => void;
  readonly snapshot: () => TerminalModeSnapshot;
}

const ESCAPE = 0x1b;
const CSI_OPEN = 0x5b;
const FULL_RESET = 0x63;
const MAX_CSI_BODY_LENGTH = 128;
const MOUSE_PROTOCOL_MODES = new Map<number, TerminalMouseProtocol>([
  [9, "x10"],
  [1000, "vt200"],
  [1002, "drag"],
  [1003, "any"],
]);
const MOUSE_ENCODING_MODES = new Map<number, TerminalMouseEncoding>([
  [1006, "sgr"],
  [1016, "sgr-pixels"],
]);
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

export function createTerminalModeTracker(): TerminalModeTracker {
  let parserState: "ground" | "escape" | "csi" | "string" | "string-escape" = "ground";
  let csiBody = "";
  let stringAcceptsBel = false;
  let alternateScreenActive = false;
  let mouseProtocol: TerminalMouseProtocol = "none";
  let mouseEncoding: TerminalMouseEncoding = "default";

  const resetModes = () => {
    alternateScreenActive = false;
    mouseProtocol = "none";
    mouseEncoding = "default";
  };

  const applyPrivateMode = (mode: number, enabled: boolean) => {
    if (ALTERNATE_SCREEN_MODES.has(mode)) alternateScreenActive = enabled;
    const protocol = MOUSE_PROTOCOL_MODES.get(mode);
    if (protocol) mouseProtocol = enabled ? protocol : "none";
    const encoding = MOUSE_ENCODING_MODES.get(mode);
    if (encoding) mouseEncoding = enabled ? encoding : "default";
  };

  const finishCsi = (final: number) => {
    if ((final !== 0x68 && final !== 0x6c) || !csiBody.startsWith("?")) return;
    const enabled = final === 0x68;
    for (const rawMode of csiBody.slice(1).split(";")) {
      if (!/^\d+$/.test(rawMode)) continue;
      applyPrivateMode(Number(rawMode), enabled);
    }
  };

  const push = (data: Uint8Array) => {
    for (const byte of data) {
      if (parserState === "ground") {
        if (byte === ESCAPE) parserState = "escape";
        continue;
      }
      if (parserState === "escape") {
        if (byte === CSI_OPEN) {
          parserState = "csi";
          csiBody = "";
        } else if (byte === FULL_RESET) {
          resetModes();
          parserState = "ground";
        } else if (byte === 0x5d || byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) {
          // OSC terminates with BEL or ST. DCS/SOS/PM/APC terminate only with ST. Ignore their
          // payloads so literal ESC [ text in a title or application string cannot change modes.
          stringAcceptsBel = byte === 0x5d;
          parserState = "string";
        } else if (byte !== ESCAPE) {
          parserState = "ground";
        }
        continue;
      }
      if (parserState === "string") {
        if (stringAcceptsBel && byte === 0x07) parserState = "ground";
        else if (byte === ESCAPE) parserState = "string-escape";
        continue;
      }
      if (parserState === "string-escape") {
        parserState = byte === 0x5c ? "ground" : (byte === ESCAPE ? "string-escape" : "string");
        continue;
      }
      if (byte >= 0x40 && byte <= 0x7e) {
        finishCsi(byte);
        parserState = "ground";
        csiBody = "";
      } else if (byte >= 0x20 && byte <= 0x3f && csiBody.length < MAX_CSI_BODY_LENGTH) {
        csiBody += String.fromCharCode(byte);
      } else if (byte === ESCAPE) {
        parserState = "escape";
        csiBody = "";
      } else {
        parserState = "ground";
        csiBody = "";
      }
    }
  };

  const snapshot = (): TerminalModeSnapshot => ({
    alternateScreenActive,
    mouseProtocol,
    mouseEncoding,
  });

  return { push, snapshot };
}

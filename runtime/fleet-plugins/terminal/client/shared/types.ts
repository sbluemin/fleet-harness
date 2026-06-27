export type TerminalRenderer = "webgl" | "dom";

export type TerminalFontId = "cascadia" | "jetbrains" | "fira-code" | "source-code-pro";

export type TerminalFontSource = "curated" | "custom";

export interface TerminalFontSettings {
  readonly source: TerminalFontSource;
  readonly id: TerminalFontId | null;
  readonly customName: string;
  readonly family: string;
  readonly size: number;
}

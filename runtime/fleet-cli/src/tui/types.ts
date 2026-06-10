export interface Component {
  getCursorAnchor?(width: number): CursorAnchor | null;
  handleInput?(data: string): void;
  invalidate(): void;
  render(width: number): string[];
}

export interface CursorAnchor {
  readonly column: number;
  readonly row: number;
  readonly visible: boolean;
}

export interface Focusable {
  focused: boolean;
}

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface InputResult {
  readonly consume: boolean;
}

export type InputListener = (data: string) => InputResult | void;

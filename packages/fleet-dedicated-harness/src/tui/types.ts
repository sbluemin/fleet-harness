export interface Component {
  invalidate(): void;
  render(width: number): string[];
}

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface InputResult {
  readonly consume: boolean;
}

export type InputListener = (data: string) => InputResult | void;


export interface FocusState<TMode extends string = string> {
  readonly mode: TMode;
}

export function createFocusState<TMode extends string = string>(mode: TMode): FocusState<TMode> {
  return { mode };
}

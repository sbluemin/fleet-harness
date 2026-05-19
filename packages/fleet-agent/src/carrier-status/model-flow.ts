export interface ModelEffortTransitionInput {
  readonly currentEffort: string | null;
  readonly effortChoices: readonly string[];
  readonly fallbackEffort: string | null;
  readonly selectedModel: string;
}

export type ModelEffortTransition =
  | { readonly kind: "commit"; readonly selection: { readonly effort?: string; readonly model: string } }
  | { readonly choices: readonly string[]; readonly cursor: number; readonly kind: "effort"; readonly pendingModel: string };

export function buildModelEffortTransition(input: ModelEffortTransitionInput): ModelEffortTransition {
  if (input.effortChoices.length === 0) {
    return {
      kind: "commit",
      selection: { model: input.selectedModel },
    };
  }

  const currentEffort = input.currentEffort && input.effortChoices.includes(input.currentEffort)
    ? input.currentEffort
    : input.fallbackEffort;
  const cursor = input.effortChoices.findIndex((level) => level === currentEffort);
  return {
    choices: input.effortChoices,
    cursor: Math.max(0, cursor),
    kind: "effort",
    pendingModel: input.selectedModel,
  };
}

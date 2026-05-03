export interface ModelEffortTransitionInput {
  currentEffort: string | null;
  effortChoices: string[];
  fallbackEffort: string | null;
  selectedModel: string;
}

export type ModelEffortTransition =
  | { kind: "commit"; selection: { model: string } }
  | { kind: "effort"; choices: string[]; cursor: number; pendingModel: string };

export function buildModelEffortTransition(
  input: ModelEffortTransitionInput,
): ModelEffortTransition {
  if (input.effortChoices.length === 0) {
    return {
      kind: "commit",
      selection: { model: input.selectedModel },
    };
  }

  const currentEffort = input.currentEffort ?? input.fallbackEffort;
  return {
    kind: "effort",
    choices: input.effortChoices,
    cursor: Math.max(0, input.effortChoices.findIndex((level) => level === currentEffort)),
    pendingModel: input.selectedModel,
  };
}

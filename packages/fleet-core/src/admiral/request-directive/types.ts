export interface DirectiveOption {
  label: string;
  description: string;
  preview?: string;
}

export interface DirectiveQuestion {
  question: string;
  header: string;
  options: DirectiveOption[];
  multiSelect?: boolean;
}

export interface DirectiveAnswer {
  question: string;
  header: string;
  values: string[];
  wasCustom: boolean;
}

export interface DirectiveResult {
  questions: DirectiveQuestion[];
  answers: DirectiveAnswer[];
  cancelled: boolean;
}

export type RenderOption = DirectiveOption & { isOther?: boolean; selected?: boolean };

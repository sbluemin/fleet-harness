import { fitLine } from "./text.js";

export function renderLine(text: string, width: number): string {
  return fitLine(text, width);
}


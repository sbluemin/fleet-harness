import { fitLine } from "./text.js";

export function renderBoxLine(text: string, width: number): string {
  return fitLine(text, width);
}


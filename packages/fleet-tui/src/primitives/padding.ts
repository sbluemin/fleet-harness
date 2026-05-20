export function padLines(lines: string[], top: number, bottom: number): string[] {
  return [...Array.from({ length: top }, () => ""), ...lines, ...Array.from({ length: bottom }, () => "")];
}


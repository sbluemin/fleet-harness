export interface FileRef {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export function isAbsolute(ref: FileRef): boolean {
  return ref.path.startsWith("/") || /^[a-z]:\//i.test(ref.path);
}

export function parseFileRef(text: string): FileRef | null {
  let value = text.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const pairs: Readonly<Record<string, string>> = { '"': '"', "'": "'", "`": "`", "(": ")", "[": "]", "{": "}", "<": ">" };
  let previous = "";
  while (previous !== value) {
    previous = value;
    value = value.replace(/[.,;!?]+$/, "").trim();
    const first = value[0];
    if (first && pairs[first] === value.at(-1)) value = value.slice(1, -1).trim();
    for (const [open, close] of Object.entries(pairs)) {
      if (open === close) continue;
      const opens = value.split(open).length;
      const closes = value.split(close).length;
      if (closes > opens && value.endsWith(close)) value = value.slice(0, -1).trim();
      else if (opens > closes && value.startsWith(open)) value = value.slice(1).trim();
    }
  }
  if (!value || /^(?:https?|mailto|javascript|data|file|ftp|vscode):/i.test(value)) return null;
  const coordinate = /(?:#L(-?\d+)(?:C(-?\d+))?|\((-?\d+)(?:,\s*(-?\d+))?\)|:(-?\d+)(?::(-?\d+))?)$/i.exec(value);
  let line: number | undefined;
  let column: number | undefined;
  if (coordinate) {
    line = Number(coordinate[1] ?? coordinate[3] ?? coordinate[5]);
    const rawColumn = coordinate[2] ?? coordinate[4] ?? coordinate[6];
    column = rawColumn === undefined ? undefined : Number(rawColumn);
    if (!Number.isSafeInteger(line) || line < 1 || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return null;
    value = value.slice(0, coordinate.index).trim();
  }
  if (!value || (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value))) return null;
  return { path: value.replace(/\\/g, "/"), ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

import { isAbsolute, parseFileRef, type FileRef } from "@fleet-console/markdown/file-ref";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * 터미널 출력의 파일 경로를 링크로 세운다 — `src/api/server.ts:10:9`, `./a.ts(3,1)`, `/abs/path.ts#L4`.
 *
 * 링크를 여는 것은 ⌘클릭(macOS)·Ctrl+클릭뿐이다. 맨 클릭은 터미널의 선택·커서 동작으로 남겨 둔다 —
 * 출력 아무 곳이나 누르다 다른 화면으로 끌려가면 터미널을 쓸 수 없다.
 *
 * 상대 경로는 그 터미널의 cwd(Theater 상대)를 기준으로 Theater 상대 경로로 바꿔 보낸다. cwd가
 * Theater 밖이면(기준이 없으면) 상대 경로 링크를 세우지 않는다. 절대 경로는 그대로 보내고, 그것을
 * Theater 상대로 바꾸거나 거절하는 일은 서버가 한다(브라우저는 절대 경로를 해석하지 않는다).
 */
export interface TerminalFileLinkContext {
  readonly theaterId: string;
  /** 터미널 cwd의 Theater 상대 경로(POSIX, 루트는 ""). Theater 밖이면 null. */
  readonly cwdRelative: string | null;
}

export interface TerminalFileLinkTarget {
  readonly theaterId: string;
  readonly path: string;
  readonly pathKind: "theater-relative" | "absolute";
  readonly line?: number;
  readonly column?: number;
}

export type TerminalFileLinkOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface TerminalFileLinks {
  /** 지금 기준. 링크를 세울 때마다 읽는다(셸이 cd하면 바뀐다). null이면 링크를 세우지 않는다. */
  readonly context: () => TerminalFileLinkContext | null;
  readonly open: (target: TerminalFileLinkTarget) => Promise<TerminalFileLinkOutcome>;
}

export function createFileLinkProvider(terminal: Terminal, deps: {
  readonly source: () => TerminalFileLinks | undefined;
  readonly isMac: boolean;
  /** 링크 위에 올라왔을 때(true)와 떠났을 때(false). 여는 법 안내를 보이는 데 쓴다. */
  readonly onHover: (hovering: boolean) => void;
  readonly onOutcome: (outcome: TerminalFileLinkOutcome) => void;
}): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const source = deps.source();
      const context = source?.context() ?? null;
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!source || !context || !line) {
        callback(undefined);
        return;
      }
      const links: ILink[] = [];
      for (const candidate of findFileRefs(readCells(line, terminal.cols))) {
        const target = toTarget(candidate.ref, context);
        if (!target) continue;
        links.push({
          range: { start: { x: candidate.startCell + 1, y: bufferLineNumber }, end: { x: candidate.endCell, y: bufferLineNumber } },
          text: candidate.text,
          decorations: { pointerCursor: false, underline: true },
          hover: () => deps.onHover(true),
          leave: () => deps.onHover(false),
          activate: (event) => {
            if (!(deps.isMac ? event.metaKey : event.ctrlKey)) return;
            event.preventDefault();
            void source.open(target).then(
              (outcome) => deps.onOutcome(outcome),
              () => deps.onOutcome({ ok: false, reason: "failed" }),
            );
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}

interface LineCells {
  readonly text: string;
  /** text의 각 UTF-16 위치가 놓인 셀(0부터). 넓은 글자는 두 셀을 차지하지만 문자열에는 한 번만 들어간다. */
  readonly cellAt: readonly number[];
  readonly cellEnd: number;
}

function readCells(line: IBufferLine, cols: number): LineCells {
  let text = "";
  const cellAt: number[] = [];
  let cellEnd = 0;
  for (let x = 0; x < Math.min(cols, line.length); x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    const width = cell.getWidth();
    if (width === 0) continue;
    const chars = cell.getChars() || " ";
    for (let index = 0; index < chars.length; index += 1) cellAt.push(x);
    text += chars;
    cellEnd = x + width;
  }
  return { text, cellAt, cellEnd };
}

interface FileRefCandidate {
  readonly ref: FileRef;
  readonly text: string;
  readonly startCell: number;
  /** 링크의 마지막 셀(1부터, 포함) — xterm 범위의 end.x 그대로. */
  readonly endCell: number;
}

const COORDINATE_SUFFIX = /^(?:#L\d+(?:C\d+)?|\(\d+(?:,\s*\d+)?\)|:\d+(?::\d+)?)/i;

export function findFileRefs(cells: LineCells): FileRefCandidate[] {
  const found: FileRefCandidate[] = [];
  for (const match of cells.text.matchAll(/\S+/g)) {
    // tsc의 `path(10,9):`처럼 좌표 뒤에 붙는 콜론은 경로의 일부가 아니다.
    const token = match[0].replace(/:+$/, "");
    if (token.includes("://")) continue;
    const ref = parseFileRef(token);
    if (!ref || !looksLikeFilePath(ref)) continue;
    // parseFileRef는 구분자를 '/'로 정규화한다 — Windows 출력(`src\\a.ts:10`)도 같은 길이로 맞춰 위치를 찾는다.
    const pathAt = token.replace(/\\/g, "/").indexOf(ref.path);
    if (pathAt < 0) continue;
    const suffix = COORDINATE_SUFFIX.exec(token.slice(pathAt + ref.path.length))?.[0] ?? "";
    const start = (match.index ?? 0) + pathAt;
    const end = start + ref.path.length + suffix.length;
    const startCell = cells.cellAt[start];
    const lastCell = cells.cellAt[end - 1];
    if (startCell === undefined || lastCell === undefined) continue;
    const nextCell = cells.cellAt[end] ?? cells.cellEnd;
    found.push({ ref, text: cells.text.slice(start, end), startCell, endCell: Math.max(lastCell + 1, nextCell) });
  }
  return found;
}

/**
 * 출력의 모든 낱말을 링크로 세우면 `and/or`·`1/2`·`e.g.`까지 밑줄이 된다. 파일로 볼 만한 모양만
 * 남긴다 — 확장자가 있는 이름, 명시적인 상대·절대 경로, 또는 줄 번호가 붙은 것.
 */
function looksLikeFilePath(ref: FileRef): boolean {
  const { path } = ref;
  if (path.length < 2 || !/[\p{L}]/u.test(path) || path.startsWith("~")) return false;
  const lastSegment = path.split("/").filter(Boolean).at(-1) ?? "";
  const hasExtension = /^[^.].*\.[\p{L}\d]{1,10}$/u.test(lastSegment);
  const explicit = path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || /^[a-z]:\//i.test(path);
  if (explicit) return true;
  if (!hasExtension) return false;
  return path.includes("/") || ref.line !== undefined;
}

function toTarget(ref: FileRef, context: TerminalFileLinkContext): TerminalFileLinkTarget | null {
  const coordinates = {
    ...(ref.line === undefined ? {} : { line: ref.line }),
    ...(ref.column === undefined ? {} : { column: ref.column }),
  };
  if (isAbsolute(ref)) return { theaterId: context.theaterId, path: ref.path, pathKind: "absolute", ...coordinates };
  if (context.cwdRelative === null) return null;
  const joined = normalizePosix(context.cwdRelative ? `${context.cwdRelative}/${ref.path}` : ref.path);
  if (joined === null) return null;
  return { theaterId: context.theaterId, path: joined, pathKind: "theater-relative", ...coordinates };
}

/** `a/./b/../c` → `a/c`. Theater 루트 위로 올라가면 null — 그 경로는 상대 링크로 세우지 않는다. */
function normalizePosix(value: string): string | null {
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

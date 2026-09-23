import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * 앱이 스스로 줄을 바꿔 그린 긴 URL을 한 링크로 세운다.
 *
 * Claude Code 같은 TUI는 긴 주소를 터미널 폭에서 직접 끊고 다음 줄을 들여 써서 잇는다. 터미널 입장에서
 * 그 줄들은 서로 무관한 줄이라(자동 줄바꿈 표시가 없다) 맨 URL 탐지는 첫 줄 조각만 링크로 세운다.
 *
 * 화면만 보고 조각을 이으면 추측이다. 그래서 이 공급자는 오른쪽 끝까지 찬 줄과 그다음 줄을 이은 글을
 * **원문 확인**(예: 그 세션 transcript에 적힌 주소인가)에 넘기고, 돌아온 원문 주소가 이은 글에 경계까지
 * 정확히 나타날 때만 전체 주소 링크를 세운다. 맞는 원문이 없으면 아무것도 내지 않아 뒤의 맨 URL 탐지가
 * 그대로 맡는다.
 *
 * 환경 변수·셸·OSC 8 전달·자동 줄바꿈 표시에 기대지 않는다 — 화면 셀과 원문 문자열만 본다.
 */

/** 한 줄이 「다음 줄로 이어질 수 있다」고 볼 만큼 찼는가 — 오른쪽 끝 두 칸 안에서 끝났는가. */
const EDGE_SLACK = 2;
/** 위아래로 따라갈 최대 줄 수. 긴 주소 하나를 좁은 폭에서 담기에 넉넉하고 호버마다 가볍다. */
const MAX_CHAIN_ROWS = 64;
/** 주소 앞에 붙어 있으면 그 주소가 더 긴 무엇의 일부라는 뜻인 문자. */
const JOINED_BEFORE = /[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]/;
/** 주소 바로 뒤에 와도 주소가 거기서 끝났다고 볼 수 있는 문자(닫는 괄호·따옴표). */
const CLOSES_AFTER = /[\s)\]}>"'`]/;
/** 문장 부호는 그 뒤가 다시 주소 글자가 아닐 때만 끝으로 본다(`file.txt`의 `.`은 끝이 아니다). */
const SENTENCE_AFTER = /[.,;:!?]/;

export interface WrappedLinkSource {
  /** 이어 붙인 글 안에 들어 있는 원문 주소들. 실패하면 빈 목록을 돌려준다. */
  readonly knownUrls: (text: string) => Promise<readonly string[]>;
  readonly activate: (event: MouseEvent, url: string) => void;
}

interface Cell {
  readonly x: number;
  readonly y: number;
}

interface Row {
  readonly text: string;
  /** text의 각 UTF-16 코드 단위가 놓인 셀. */
  readonly cells: readonly Cell[];
  /** 마지막으로 공백이 아닌 글자가 놓인 열, 빈 줄이면 -1. */
  readonly lastColumn: number;
}

export interface WrappedChain {
  readonly text: string;
  readonly cells: readonly Cell[];
  /** 이어진 줄이 시작하는 text 위치 — 줄 경계는 화면상 주소의 경계일 수 있다. */
  readonly rowStarts: ReadonlySet<number>;
}

export interface WrappedLinkMatch {
  readonly url: string;
  readonly start: Cell;
  readonly end: Cell;
}

export function createWrappedLinkProvider(terminal: Terminal, source: WrappedLinkSource, cacheMs = 2000): ILinkProvider {
  // 같은 묶음의 줄마다 호버가 오므로 이은 글 단위로 잠시 기억한다. 응답이 막 끝난 주소도 곧 다시 묻는다.
  const cache = new Map<string, { readonly at: number; readonly urls: Promise<readonly string[]> }>();
  const loadUrls = (text: string): Promise<readonly string[]> => {
    const now = Date.now();
    for (const [key, entry] of cache) if (now - entry.at >= cacheMs) cache.delete(key);
    const hit = cache.get(text);
    if (hit) return hit.urls;
    const urls = source.knownUrls(text).catch(() => [] as readonly string[]);
    cache.set(text, { at: now, urls });
    return urls;
  };

  return {
    provideLinks(bufferLineNumber, callback) {
      const y = bufferLineNumber - 1;
      const chain = readChain(terminal, y);
      // 한 줄짜리는 이을 것이 없다 — 맨 URL 탐지가 맡는다. 원문 조회도 하지 않는다.
      if (!chain || !chain.text.includes("http")) {
        callback(undefined);
        return;
      }
      void loadUrls(chain.text).then((urls) => {
        // 원문을 묻는 동안 화면이 바뀌었으면 그 답은 이 화면의 것이 아니다.
        const fresh = readChain(terminal, y);
        const matches = fresh && fresh.text === chain.text ? matchWrappedLinks(fresh, urls).filter((match) => match.start.y <= y && match.end.y >= y && match.start.y !== match.end.y) : [];
        callback(matches.length === 0 ? undefined : matches.map((match): ILink => ({
          text: match.url,
          range: { start: { x: match.start.x + 1, y: match.start.y + 1 }, end: { x: match.end.x + 1, y: match.end.y + 1 } },
          activate: (event) => source.activate(event, match.url),
        })));
      });
    },
  };
}

/**
 * y를 품은 「이어진 줄 묶음」을 읽는다. 앞줄이 오른쪽 끝까지 찼을 때만 다음 줄로 잇고, 이어지는 줄의
 * 들여쓰기는 떼어 낸다. 이어진 줄이 없으면 null.
 */
function readChain(terminal: Terminal, y: number): WrappedChain | null {
  const buffer = terminal.buffer.active;
  const cols = terminal.cols;
  const rowAt = (row: number): Row | null => {
    const line = buffer.getLine(row);
    return line ? readRow(line, row, cols) : null;
  };
  const reachesEdge = (row: Row | null): boolean => row !== null && row.lastColumn >= cols - EDGE_SLACK;

  let top = y;
  while (top > 0 && y - top < MAX_CHAIN_ROWS && reachesEdge(rowAt(top - 1))) top -= 1;
  let bottom = y;
  while (bottom - top < MAX_CHAIN_ROWS && reachesEdge(rowAt(bottom))) {
    if (bottom + 1 >= buffer.length) break;
    bottom += 1;
  }
  if (bottom === top) return null;

  const rows: Row[] = [];
  for (let row = top; row <= bottom; row += 1) {
    const read = rowAt(row);
    if (!read) return null;
    rows.push(read);
  }
  return joinRows(rows);
}

function readRow(line: IBufferLine, y: number, cols: number): Row {
  let text = "";
  const cells: Cell[] = [];
  let lastColumn = -1;
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i += 1) cells.push({ x, y });
    text += chars;
    if (chars.trim() !== "") lastColumn = x;
  }
  return { text, cells, lastColumn };
}

/** 첫 줄은 그대로, 이어지는 줄은 들여쓰기를 떼고, 각 줄은 마지막 글자까지만 이어 붙인다. */
export function joinRows(rows: readonly Row[]): WrappedChain {
  let text = "";
  const cells: Cell[] = [];
  const rowStarts = new Set<number>();
  rows.forEach((row, index) => {
    let from = 0;
    if (index > 0) while (from < row.text.length && row.text[from] === " ") from += 1;
    let to = row.text.length;
    while (to > from && row.text[to - 1] === " ") to -= 1;
    if (index > 0) rowStarts.add(text.length);
    text += row.text.slice(from, to);
    cells.push(...row.cells.slice(from, to));
  });
  return { text, cells, rowStarts };
}

/**
 * 이어 붙인 글에서 원문 주소를 찾는다. 긴 주소부터, 겹치지 않게, 앞뒤 경계가 주소의 끝일 때만 받는다 —
 * 원문보다 길게 이어진 글(다음 줄의 무관한 낱말이 붙은 경우)은 경계에서 걸러진다.
 */
export function matchWrappedLinks(chain: WrappedChain, urls: readonly string[]): WrappedLinkMatch[] {
  const taken: Array<readonly [number, number]> = [];
  const matches: WrappedLinkMatch[] = [];
  const candidates = [...new Set(urls)].filter((url) => url.length > 0 && url.length <= chain.text.length).sort((a, b) => b.length - a.length);
  for (const url of candidates) {
    let from = 0;
    for (;;) {
      const index = chain.text.indexOf(url, from);
      if (index < 0) break;
      from = index + 1;
      const end = index + url.length;
      const before = chain.text[index - 1];
      if (before !== undefined && JOINED_BEFORE.test(before) && !chain.rowStarts.has(index)) continue;
      if (!endsAt(chain, end)) continue;
      if (taken.some(([s, e]) => index < e && end > s)) continue;
      const start = chain.cells[index];
      const last = chain.cells[end - 1];
      if (!start || !last) continue;
      taken.push([index, end]);
      matches.push({ url, start, end: last });
    }
  }
  return matches;
}

function endsAt(chain: WrappedChain, end: number): boolean {
  const after = chain.text[end];
  if (after === undefined || chain.rowStarts.has(end) || CLOSES_AFTER.test(after)) return true;
  if (!SENTENCE_AFTER.test(after)) return false;
  const next = chain.text[end + 1];
  return next === undefined || chain.rowStarts.has(end + 1) || !JOINED_BEFORE.test(next);
}

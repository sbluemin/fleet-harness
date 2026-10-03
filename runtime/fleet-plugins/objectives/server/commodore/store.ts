import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ObjectiveStoreError } from "../store.js";
import {
  commodoreStateSchema,
  commodoreTranscriptEntrySchema,
  EMPTY_COMMODORE_STATE,
  EMPTY_RUN_TOTALS,
  MAX_DIRECTIVE,
  MAX_INTEL_ITEMS,
  MAX_INTEL_TEXT,
  MAX_SOURCES,
  MAX_TRANSCRIPT_PAGE,
  type CommodoreCoordinates,
  type CommodoreEvent,
  type CommodoreIntel,
  type CommodoreRunTotals,
  type CommodoreSource,
  type CommodoreState,
  type CommodoreStateChange,
  type CommodoreTranscriptEntry,
  type CommodoreTranscriptInput,
} from "./types.js";

/**
 * 사령관 상태 저장소 — Theater 의 목표 폴더 안 `commodore/` 하나.
 *
 * ```
 * commodore/state.json         자율 운영·지시·정보·정보 출처·Theater 별 좌표
 * commodore/transcript.jsonl   사령관 기록(한 줄 한 항목, seq 단조 증가)
 * ```
 *
 * 목표 저장소와 같은 원칙이다: Console 이 유일한 쓰는 쪽이라 잠금도 감시도 없고, 모든 변경은 `commit` 한 곳을 지나 tmp→rename
 * 으로 쓰인 뒤에야 캐시가 갈리고 마지막에 사건으로 방송된다. 기록은 덧붙이기만 하고, 파일이 자라면 최근 절반만 남긴다.
 */

export interface CommodoreStoreOptions {
  /** Theater 의 목표 디렉터리(`workspaces/<프로젝트>/objectives`). Theater 경로를 모르면 null. */
  readonly dirOf: (theaterId: string) => string | null;
  readonly theaterIds?: () => readonly string[];
  readonly emit: (event: CommodoreEvent) => void;
  readonly now?: () => number;
}

export interface CommodoreTranscriptPage {
  readonly entries: readonly CommodoreTranscriptEntry[];
  /** 더 오래된 항목이 남아 있다 — 첫 항목의 seq 를 `before` 로 넘겨 이어 읽는다. */
  readonly hasMore: boolean;
}

export interface CommodoreStore {
  /** Theater 를 모르거나 폴더를 읽을 수 없으면 null. 없는 파일은 빈 상태다. */
  read(theaterId: string): CommodoreState | null;
  setAutonomy(theaterId: string, autonomy: boolean): CommodoreState;
  /** 본문이 그대로면 rev 도 그대로다 — 같은 지시를 다시 저장해 사령관을 깨우지 않는다. */
  setDirective(theaterId: string, text: string): CommodoreState;
  addIntel(theaterId: string, input: { readonly text: string; readonly source?: string }): { readonly state: CommodoreState; readonly item: CommodoreIntel };
  removeIntel(theaterId: string, intelId: string): CommodoreState;
  setSources(theaterId: string, sources: readonly Omit<CommodoreSource, "id">[]): CommodoreState;
  setCoordinates(theaterId: string, coordinates: CommodoreCoordinates | null): CommodoreState;
  /** 누적 셈을 더한다(세션 +1, 비용 +, 행위 +). 감독자가 턴 결과마다 부른다. */
  addRunTotals(theaterId: string, delta: Partial<CommodoreRunTotals>): CommodoreState;
  transcriptAppend(theaterId: string, input: CommodoreTranscriptInput): CommodoreTranscriptEntry;
  transcriptRead(theaterId: string, options?: { readonly limit?: number; readonly before?: number }): CommodoreTranscriptPage;
  /** 저장된 상태가 자율 운영을 켠 Theater — 재시작 복원이 읽는다. 폴더를 읽을 수 없는 Theater 는 빠진다. */
  autonomousTheaters(): readonly string[];
  /** 서버 안 구독 — 감독자가 지시·정보 변경을 깨움 이유로 받는다. 브라우저 방송(`emit`)과 별개다. */
  subscribe(listener: (event: CommodoreEvent) => void): () => void;
}

const STATE_FILE = "state.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
/** 기록 파일이 이 크기를 넘으면 최근 절반만 남긴다. */
const TRANSCRIPT_COMPACT_BYTES = 4 * 1024 * 1024;
const DEFAULT_PAGE = 200;

export function createCommodoreStore(options: CommodoreStoreOptions): CommodoreStore {
  const now = options.now ?? Date.now;
  const states = new Map<string, CommodoreState>();
  const lastSeq = new Map<string, number>();
  const listeners = new Set<(event: CommodoreEvent) => void>();

  const dirFor = (theaterId: string): string => {
    const dir = options.dirOf(theaterId);
    if (!dir) throw new ObjectiveStoreError("theater_unavailable");
    return path.join(dir, "commodore");
  };
  const stateFile = (theaterId: string) => path.join(dirFor(theaterId), STATE_FILE);
  const transcriptFile = (theaterId: string) => path.join(dirFor(theaterId), TRANSCRIPT_FILE);

  const load = (theaterId: string): CommodoreState => {
    const cached = states.get(theaterId);
    if (cached) return cached;
    const state = readStateFile(stateFile(theaterId));
    states.set(theaterId, state);
    return state;
  };

  const broadcast = (event: CommodoreEvent) => {
    options.emit(event);
    for (const listener of listeners) {
      try { listener(event); } catch (error) { console.warn(`[objectives] commodore listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };

  /** 상태 한 건을 검증해 쓰고, 성공한 뒤에만 캐시를 갈고 방송한다. */
  const commit = (theaterId: string, next: CommodoreState, change: CommodoreStateChange): CommodoreState => {
    const parsed = commodoreStateSchema.safeParse(next);
    if (!parsed.success) throw new ObjectiveStoreError("invalid_request");
    const file = stateFile(theaterId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(parsed.data));
    states.set(theaterId, parsed.data);
    broadcast({ op: "state", theaterId, state: parsed.data, change });
    return parsed.data;
  };

  const seqOf = (theaterId: string): number => {
    const known = lastSeq.get(theaterId);
    if (known !== undefined) return known;
    const entries = readTranscriptFile(transcriptFile(theaterId));
    const seq = entries.length ? entries[entries.length - 1]!.seq : 0;
    lastSeq.set(theaterId, seq);
    return seq;
  };

  return {
    read(theaterId) {
      try { return load(theaterId); }
      catch (error) {
        if (error instanceof ObjectiveStoreError && error.code === "theater_unavailable") return null;
        throw error;
      }
    },
    setAutonomy(theaterId, autonomy) {
      const current = load(theaterId);
      if (current.autonomy === autonomy) return current;
      return commit(theaterId, { ...current, autonomy }, "autonomy");
    },
    setDirective(theaterId, text) {
      if (text.length > MAX_DIRECTIVE) throw new ObjectiveStoreError("invalid_request");
      const current = load(theaterId);
      if (current.directive.text === text) return current;
      return commit(theaterId, { ...current, directive: { text, rev: current.directive.rev + 1, updatedAt: now() } }, "directive");
    },
    addIntel(theaterId, input) {
      const text = input.text.trim();
      if (!text || text.length > MAX_INTEL_TEXT) throw new ObjectiveStoreError("invalid_request");
      const current = load(theaterId);
      const item: CommodoreIntel = { id: `i_${randomUUID().slice(0, 8)}`, at: now(), source: input.source?.trim() || "person", text };
      // 최신이 앞이다 — 사령관 도구가 "지난번 이후" 를 앞에서부터 읽는다. 상한을 넘으면 가장 오래된 것이 떨어진다.
      const intel = [item, ...current.intel].slice(0, MAX_INTEL_ITEMS);
      return { state: commit(theaterId, { ...current, intel }, "intel"), item };
    },
    removeIntel(theaterId, intelId) {
      const current = load(theaterId);
      const intel = current.intel.filter((entry) => entry.id !== intelId);
      if (intel.length === current.intel.length) throw new ObjectiveStoreError("unknown_intel");
      return commit(theaterId, { ...current, intel }, "intel");
    },
    setSources(theaterId, sources) {
      if (sources.length > MAX_SOURCES) throw new ObjectiveStoreError("invalid_request");
      const current = load(theaterId);
      // 같은 종류·위치의 출처는 id 를 잇는다 — 정보 항목의 source 가 가리키는 자리가 바뀌지 않게.
      const next = sources.map((source) => ({ id: current.sources.find((known) => known.kind === source.kind && known.locator === source.locator)?.id ?? `s_${randomUUID().slice(0, 8)}`, ...source }));
      return commit(theaterId, { ...current, sources: next }, "sources");
    },
    setCoordinates(theaterId, coordinates) {
      const current = load(theaterId);
      const { model: _model, effort: _effort, ...rest } = current;
      return commit(theaterId, coordinates ? { ...rest, model: coordinates.model, effort: coordinates.effort } : rest, "coordinates");
    },
    addRunTotals(theaterId, delta) {
      const current = load(theaterId);
      const run = current.run ?? EMPTY_RUN_TOTALS;
      return commit(theaterId, { ...current, run: { session: run.session + (delta.session ?? 0), costUsd: run.costUsd + (delta.costUsd ?? 0), actions: run.actions + (delta.actions ?? 0) } }, "run");
    },
    transcriptAppend(theaterId, input) {
      const entry = { ...input, seq: seqOf(theaterId) + 1, at: now() } as CommodoreTranscriptEntry;
      const parsed = commodoreTranscriptEntrySchema.safeParse(entry);
      if (!parsed.success) throw new ObjectiveStoreError("invalid_request");
      const file = transcriptFile(theaterId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
      lastSeq.set(theaterId, parsed.data.seq);
      compactIfLarge(file);
      broadcast({ op: "transcript", theaterId, entry: parsed.data });
      return parsed.data;
    },
    transcriptRead(theaterId, pageOptions) {
      const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE, pageOptions?.limit ?? DEFAULT_PAGE));
      const entries = readTranscriptFile(transcriptFile(theaterId));
      const before = pageOptions?.before;
      const scoped = before === undefined ? entries : entries.filter((entry) => entry.seq < before);
      return { entries: scoped.slice(Math.max(0, scoped.length - limit)), hasMore: scoped.length > limit };
    },
    autonomousTheaters() {
      const ids = new Set<string>([...states.keys(), ...(options.theaterIds?.() ?? [])]);
      const result: string[] = [];
      for (const theaterId of ids) {
        try { if (load(theaterId).autonomy) result.push(theaterId); }
        catch { /* 읽을 수 없는 Theater 는 복원 대상이 아니다 — 폴더가 돌아오면 다음 읽기가 다시 푼다. */ }
      }
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** 없는 파일은 빈 상태, 깨진 파일은 옆으로 치우고 빈 상태 — 한 Theater 의 깨진 파일이 플러그인 전체를 세우지 않는다. */
function readStateFile(file: string): CommodoreState {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_COMMODORE_STATE;
    throw error;
  }
  try {
    const parsed = commodoreStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* 아래에서 치운다 */ }
  console.warn(`[objectives] commodore state unreadable, set aside: ${file}`);
  try { fs.renameSync(file, `${file}.broken-${Date.now()}-${randomUUID()}`); } catch { /* 치우지 못해도 빈 상태로 간다 */ }
  return EMPTY_COMMODORE_STATE;
}

/** 깨진 줄은 건너뛴다 — 기록은 보여 주는 것이지 상태가 아니라 한 줄의 손상이 전체를 막지 않는다. */
function readTranscriptFile(file: string): CommodoreTranscriptEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: CommodoreTranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = commodoreTranscriptEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch { /* 건너뛴다 */ }
  }
  return entries;
}

function compactIfLarge(file: string): void {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size <= TRANSCRIPT_COMPACT_BYTES) return;
  const entries = readTranscriptFile(file);
  const kept = entries.slice(Math.floor(entries.length / 2));
  writeFileAtomic(file, kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : ""));
}

/** tmp→rename. tmp 는 매번 새 이름으로 배타 생성해 이미 있는 자리(특히 밖을 가리키는 링크)를 따라가며 쓰지 않는다. */
function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 없으면 그만 */ }
    throw error;
  }
}

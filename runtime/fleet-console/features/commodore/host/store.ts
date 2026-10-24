import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { canonicalModelId } from "../../ai-gateway/shared/models.js";
import { createCommodoreImages } from "./images.js";
import { createCommodoreMemory, type CommodoreMemory } from "./memory.js";

import { CommodoreStoreError } from "./errors.js";
import { migrateCommodorePatrolState } from "./state-migration.js";
import { patrolIntervalMs } from "../shared/contracts/types.js";
import { commodoreStateSchema, commodoreTranscriptEntrySchema, EMPTY_COMMODORE_STATE, EMPTY_RUN_TOTALS, MAX_DIRECTIVE, MAX_INTEL_ITEMS, MAX_INTEL_TEXT, MAX_KEPT_ASKS, MAX_OPEN_ASKS, MAX_ASK_REASON, MAX_SOURCES, MAX_TRANSCRIPT_PAGE, type CommodoreAsk, type CommodoreCoordinates, type CommodoreEvent, type CommodorePatrolMinutes, type CommodoreIntel, type CommodoreRunTotals, type CommodoreSource, type CommodoreState, type CommodoreStateChange, type CommodoreTranscriptEntry, type CommodoreTranscriptInput } from "../shared/contracts/types.js";

/**
 * 사령관 상태 저장소 — Console 데이터의 `commodore/<UUID>/` 하나.
 *
 * ```
 * commodore/state.json         자율 운영·지시·정보·정보 출처·Theater 별 좌표
 * commodore/transcript.jsonl   사령관 기록(한 줄 한 항목, seq 단조 증가)
 * commodore/images/<메시지>/<첨부>.<확장자>   기록을 따라 보존·정리하는 이미지 사본
 * commodore/memory/…           사령관만 쓰는 fleet-memory(`memory.ts`)
 * ```
 *
 * 목표 저장소와 같은 원칙이다: Console 이 유일한 쓰는 쪽이라 잠금도 감시도 없고, 모든 변경은 `commit` 한 곳을 지나 tmp→rename
 * 으로 쓰인 뒤에야 캐시가 갈리고 마지막에 사건으로 방송된다. 기록은 덧붙이기만 하고, 파일이 자라면 최근 절반만 남긴다.
 */

export interface CommodoreStoreOptions {
  /** 사령관 엔티티 디렉터리. UUID를 모르거나 안전하게 읽을 수 없으면 null. */
  readonly dirOf: (commodoreId: string) => string | null;
  readonly commodoreIds?: () => readonly string[];
  readonly theatersOf: (commodoreId: string) => readonly { readonly path: string }[];
  readonly theaterIdsOf: (commodoreId: string) => readonly string[];
  readonly emit: (event: CommodoreEvent) => void;
  readonly now?: () => number;
  /** 기록 사본의 Theater 별 총량 — 생략하면 제품 기본 상한이다. */
  readonly maxRetainedImageBytes?: number;
}

export interface CommodoreTranscriptPage {
  readonly entries: readonly CommodoreTranscriptEntry[];
  /** 더 오래된 항목이 남아 있다 — 첫 항목의 seq 를 `before` 로 넘겨 이어 읽는다. */
  readonly hasMore: boolean;
  readonly clearedThrough: number;
}

export interface CommodoreStore {
  /** Theater 를 모르거나 폴더를 읽을 수 없으면 null. 없는 파일은 빈 상태다. */
  read(commodoreId: string): CommodoreState | null;
  /** 종료 예약 — null은 해제. 자율 운영 중에만 받고, 지난 시각은 거절한다. */
  setStopAt(commodoreId: string, stopAt: number | null): CommodoreState;
  /** 본문이 그대로면 rev 도 그대로다 — 같은 지시를 다시 저장해 사령관을 깨우지 않는다. */
  setDirective(commodoreId: string, text: string): CommodoreState;
  addIntel(commodoreId: string, input: { readonly text: string; readonly source?: string }): { readonly state: CommodoreState; readonly item: CommodoreIntel };
  /** 사람이 항목 본문을 고친다 — id·출처·자리는 그대로, `editedAt` 이 남는다. 본문이 그대로면 사건도 없다(사령관을 헛되이 깨우지 않는다). */
  editIntel(commodoreId: string, intelId: string, text: string): { readonly state: CommodoreState; readonly item: CommodoreIntel };
  removeIntel(commodoreId: string, intelId: string): CommodoreState;
  setSources(commodoreId: string, sources: readonly Omit<CommodoreSource, "id">[]): CommodoreState;
  setCoordinates(commodoreId: string, coordinates: CommodoreCoordinates | null): CommodoreState;
  /** 사령관이 만드는 목표의 지휘관 모델·강도 — null 은 보드 기본값으로 되돌린다. */
  setCommander(commodoreId: string, commander: { readonly model: string; readonly effort?: string } | null): CommodoreState;
  /** 순찰 간격 — 안 함은 자동 깨움과 종료 예약을 해제한다. 같으면 아무 일도 없다. */
  setPatrol(commodoreId: string, minutes: CommodorePatrolMinutes): CommodoreState;
  /** 사람이 이 Theater 를 보는 언어를 남긴다 — 같으면 아무 일도 없다. */
  setLanguage(commodoreId: string, language: "en" | "ko"): CommodoreState;
  /** 누적 셈을 더한다(세션 +1, 비용 +, 행위 +). 감독자가 턴 결과마다 부른다. */
  addRunTotals(commodoreId: string, delta: Partial<CommodoreRunTotals>): CommodoreState;
  /** 감독자가 세션을 거둔 뒤 부른다. 기록 파일을 지우되 지시·인텔·설정은 보존한다. */
  transcriptClear(commodoreId: string): CommodoreState;
  readonly images: ReturnType<typeof createCommodoreImages>;
  /** fleet-memory — 쓰기는 사령관 도구만, 화면은 읽기만 한다. 바뀌면 `memory` 사건이 나간다. */
  readonly memory: CommodoreMemory;
  transcriptAppend(commodoreId: string, input: CommodoreTranscriptInput): CommodoreTranscriptEntry;
  transcriptRead(commodoreId: string, options?: { readonly limit?: number; readonly before?: number }): CommodoreTranscriptPage;
  /**
   * 사람에게 묻는다 — 기록에 `ask` 줄을 남긴다. 같은 목표에 같은 질문이 이미 서 있으면 그 질문을 그대로 둔다(reused).
   * 서 있는 질문이 상한(`MAX_OPEN_ASKS`)이면 `too_many_asks`.
   */
  askAdd(commodoreId: string, input: { readonly questions: readonly AskQuestionInput[]; readonly reason: string; readonly objective: { readonly id: string; readonly title: string } | null }): { readonly state: CommodoreState; readonly ask: CommodoreAsk; readonly reused: boolean };
  /** 사령관이 질문을 거둔다. 이미 거둔 질문은 그대로(withdrawn false), 답한 질문은 `ask_already_answered`. */
  askWithdraw(commodoreId: string, askId: string): { readonly state: CommodoreState; readonly ask: CommodoreAsk; readonly withdrawn: boolean };
  /**
   * 사람의 답 — 모든 질문에 한 번에. 기록에 `ask-answered` 줄을 남긴다. 같은 답의 재전송은 그 결과를 그대로(repeated),
   * 다른 답은 `ask_already_answered`, 거둔 질문은 `ask_withdrawn`, 모르는 질문은 `unknown_ask`, 어긋난 답은 `invalid_answers`.
   */
  askAnswer(commodoreId: string, askId: string, answers: readonly AskAnswerInput[]): { readonly state: CommodoreState; readonly ask: CommodoreAsk; readonly repeated: boolean };
  /** 사령관이 답을 읽었다 — 답한 질문에 읽은 시각을 남긴다. */
  askRead(commodoreId: string, askIds: readonly string[]): CommodoreState;
  /** 저장된 상태가 자율 운영을 켠 Theater — 재시작 복원이 읽는다. 폴더를 읽을 수 없는 Theater 는 빠진다. */
  patrollingCommodores(): readonly string[];
  /** 서버 안 구독 — 감독자가 지시·정보 변경을 깨움 이유로 받는다. 브라우저 방송(`emit`)과 별개다. */
  subscribe(listener: (event: CommodoreEvent) => void): () => void;
}

export interface AskQuestionInput {
  readonly header?: string | undefined;
  readonly text: string;
  readonly options: readonly { readonly label: string; readonly description?: string | undefined }[];
  readonly multiSelect?: boolean | undefined;
}
export interface AskAnswerInput {
  readonly questionId: string;
  readonly selectedOptionIds: readonly string[];
  readonly text: string;
}

/** 서 있는 질문은 모두, 끝난 질문은 최근 것부터 남긴다 — 순서는 물은 순서 그대로. */
function keptAsks(asks: readonly CommodoreAsk[]): CommodoreAsk[] {
  const settled = asks.filter((ask) => ask.settled).sort((a, b) => b.settled!.at - a.settled!.at);
  const dropped = new Set(settled.slice(Math.max(0, MAX_KEPT_ASKS - asks.filter((ask) => !ask.settled).length)).map((ask) => ask.id));
  return asks.filter((ask) => !dropped.has(ask.id));
}

/** 기록에 싣는 답 — 질문 원문, 고른 선택지 이름, 직접 쓴 말. */
export function askAnswerLines(ask: CommodoreAsk): { readonly question: string; readonly selected: readonly string[]; readonly text: string }[] {
  return (ask.settled?.answers ?? []).map((answer) => {
    const question = ask.questions.find((entry) => entry.id === answer.questionId);
    return { question: question?.text ?? "", selected: answer.selectedOptionIds.flatMap((id) => question?.options.filter((option) => option.id === id).map((option) => option.label) ?? []), text: answer.text };
  });
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

  const dirFor = (commodoreId: string): string => {
    const dir = options.dirOf(commodoreId);
    if (!dir) throw new CommodoreStoreError("theater_unavailable");
    return dir;
  };
  const images = createCommodoreImages((commodoreId) => {
    const dir = options.dirOf(commodoreId);
    if (!dir) throw new CommodoreStoreError("theater_unavailable");
    return dir;
  }, {
    maxBytes: options.maxRetainedImageBytes,
    messageSeqs: (commodoreId) => new Map(readTranscriptFile(path.join(dirFor(commodoreId), TRANSCRIPT_FILE)).flatMap((entry) => entry.kind === "message" && entry.messageId ? [[entry.messageId, entry.seq] as const] : [])),
  });
  const pruneImages = (commodoreId: string, kept?: ReadonlySet<string>) => {
    try { images.prune(commodoreId, kept); }
    catch { console.warn("[objectives] commodore image cleanup failed; retained copies will be retried on the next cleanup"); }
  };
  const stateFile = (commodoreId: string) => path.join(dirFor(commodoreId), STATE_FILE);
  const transcriptFile = (commodoreId: string) => path.join(dirFor(commodoreId), TRANSCRIPT_FILE);

  const load = (commodoreId: string): CommodoreState => {
    const cached = states.get(commodoreId);
    if (cached) return cached;
    const state = readStateFile(stateFile(commodoreId));
    states.set(commodoreId, state);
    return state;
  };

  const broadcast = (event: CommodoreEvent) => {
    options.emit(event);
    for (const listener of listeners) {
      try { listener(event); } catch (error) { console.warn(`[objectives] commodore listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };

  /** 상태 한 건을 검증해 쓰고, 성공한 뒤에만 캐시를 갈고 방송한다. */
  const commit = (commodoreId: string, next: CommodoreState, change: CommodoreStateChange, intelId?: string, removedIntel?: Pick<CommodoreIntel, "id" | "text">): CommodoreState => {
    const parsed = commodoreStateSchema.safeParse(next);
    if (!parsed.success) throw new CommodoreStoreError("invalid_request");
    const file = stateFile(commodoreId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ ...parsed.data, theaters: options.theatersOf(commodoreId) }));
    states.set(commodoreId, parsed.data);
    broadcast({ op: "state", commodoreId, theaterIds: options.theaterIdsOf(commodoreId), state: parsed.data, change, ...(intelId ? { intelId } : {}), ...(removedIntel ? { removedIntel } : {}) });
    return parsed.data;
  };

  const seqOf = (commodoreId: string): number => {
    const known = lastSeq.get(commodoreId);
    if (known !== undefined) return known;
    const entries = readTranscriptFile(transcriptFile(commodoreId));
    const seq = Math.max(load(commodoreId).transcriptClearedThrough ?? 0, entries.length ? entries[entries.length - 1]!.seq : 0);
    lastSeq.set(commodoreId, seq);
    return seq;
  };

  const append = (commodoreId: string, input: CommodoreTranscriptInput): CommodoreTranscriptEntry => {
    const entry = { ...input, seq: seqOf(commodoreId) + 1, at: now() } as CommodoreTranscriptEntry;
    const parsed = commodoreTranscriptEntrySchema.safeParse(entry);
    if (!parsed.success) throw new CommodoreStoreError("invalid_request");
    const file = transcriptFile(commodoreId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
    lastSeq.set(commodoreId, parsed.data.seq);
    const kept = compactIfLarge(file);
    if (kept) pruneImages(commodoreId, new Set(kept.flatMap((entry) => entry.kind === "message" && entry.messageId ? [entry.messageId] : [])));
    broadcast({ op: "transcript", commodoreId, theaterIds: options.theaterIdsOf(commodoreId), entry: parsed.data });
    return parsed.data;
  };

  const memory = createCommodoreMemory({
    dirFor,
    now,
    writeFile: writeFileAtomic,
    onChange: (commodoreId, change, ref) => broadcast({ op: "memory", commodoreId, theaterIds: options.theaterIdsOf(commodoreId), change, ref }),
  });

  return {
    read(commodoreId) {
      try { return load(commodoreId); }
      catch (error) {
        if (error instanceof CommodoreStoreError && error.code === "theater_unavailable") return null;
        throw error;
      }
    },
    setStopAt(commodoreId, stopAt) {
      const current = load(commodoreId);
      if (patrolIntervalMs(current) === null) throw new CommodoreStoreError("commodore_inactive");
      const at = now();
      if (current.stopAt !== undefined && current.stopAt <= at) throw new CommodoreStoreError("commodore_stopping");
      if (stopAt !== null && (!Number.isSafeInteger(stopAt) || stopAt <= at || stopAt > 8_640_000_000_000_000)) throw new CommodoreStoreError("invalid_request");
      if ((current.stopAt ?? null) === stopAt) return current;
      const { stopAt: _stopAt, ...rest } = current;
      return commit(commodoreId, stopAt === null ? rest : { ...rest, stopAt }, "stopAt");
    },
    setDirective(commodoreId, text) {
      if (text.length > MAX_DIRECTIVE) throw new CommodoreStoreError("invalid_request");
      const current = load(commodoreId);
      if (current.directive.text === text) return current;
      return commit(commodoreId, { ...current, directive: { text, rev: current.directive.rev + 1, updatedAt: now() } }, "directive");
    },
    addIntel(commodoreId, input) {
      const text = input.text.trim();
      if (!text || text.length > MAX_INTEL_TEXT) throw new CommodoreStoreError("invalid_request");
      const current = load(commodoreId);
      const item: CommodoreIntel = { id: `i_${randomUUID().slice(0, 8)}`, at: now(), source: input.source?.trim() || "person", text };
      // 최신이 앞이다 — 사령관 도구가 "지난번 이후" 를 앞에서부터 읽는다. 상한을 넘으면 가장 오래된 것이 떨어진다.
      const intel = [item, ...current.intel].slice(0, MAX_INTEL_ITEMS);
      return { state: commit(commodoreId, { ...current, intel }, "intel", item.id), item };
    },
    editIntel(commodoreId, intelId, input) {
      const text = input.trim();
      if (!text || text.length > MAX_INTEL_TEXT) throw new CommodoreStoreError("invalid_request");
      const current = load(commodoreId);
      const index = current.intel.findIndex((entry) => entry.id === intelId);
      if (index < 0) throw new CommodoreStoreError("unknown_intel");
      const existing = current.intel[index]!;
      if (existing.text === text) return { state: current, item: existing };
      const item: CommodoreIntel = { ...existing, text, editedAt: now() };
      const intel = current.intel.map((entry, at) => (at === index ? item : entry));
      return { state: commit(commodoreId, { ...current, intel }, "intel-edited", intelId), item };
    },
    removeIntel(commodoreId, intelId) {
      const current = load(commodoreId);
      const item = current.intel.find((entry) => entry.id === intelId);
      if (!item) throw new CommodoreStoreError("unknown_intel");
      const intel = current.intel.filter((entry) => entry.id !== intelId);
      return commit(commodoreId, { ...current, intel }, "intel-removed", intelId, { id: item.id, text: item.text });
    },
    setSources(commodoreId, sources) {
      if (sources.length > MAX_SOURCES) throw new CommodoreStoreError("invalid_request");
      const current = load(commodoreId);
      // 같은 종류·위치의 출처는 id 를 잇는다 — 정보 항목의 source 가 가리키는 자리가 바뀌지 않게.
      const next = sources.map((source) => ({ id: current.sources.find((known) => known.kind === source.kind && known.locator === source.locator)?.id ?? `s_${randomUUID().slice(0, 8)}`, ...source }));
      return commit(commodoreId, { ...current, sources: next }, "sources");
    },
    setCoordinates(commodoreId, coordinates) {
      const current = load(commodoreId);
      const { model: _model, effort: _effort, ...rest } = current;
      return commit(commodoreId, coordinates ? { ...rest, model: coordinates.model, effort: coordinates.effort } : rest, "coordinates");
    },
    setCommander(commodoreId, commander) {
      const current = load(commodoreId);
      const { commanderModel: _model, commanderEffort: _effort, ...rest } = current;
      return commit(commodoreId, commander ? { ...rest, commanderModel: commander.model, ...(commander.effort ? { commanderEffort: commander.effort } : {}) } : rest, "commander");
    },
    setPatrol(commodoreId, minutes) {
      const current = load(commodoreId);
      if ((current.patrolMinutes ?? "off") === minutes && (minutes !== "off" || current.stopAt === undefined)) return current;
      const { stopAt: _stopAt, ...withoutSchedule } = current;
      return commit(commodoreId, { ...(minutes === "off" ? withoutSchedule : current), patrolMinutes: minutes }, "patrol");
    },
    setLanguage(commodoreId, language) {
      const current = load(commodoreId);
      if (current.language === language) return current;
      return commit(commodoreId, { ...current, language }, "language");
    },
    addRunTotals(commodoreId, delta) {
      const current = load(commodoreId);
      const run = current.run ?? EMPTY_RUN_TOTALS;
      return commit(commodoreId, { ...current, run: { session: run.session + (delta.session ?? 0), costUsd: run.costUsd + (delta.costUsd ?? 0), actions: run.actions + (delta.actions ?? 0) } }, "run");
    },
    transcriptClear(commodoreId) {
      const current = load(commodoreId);
      const clearedThrough = seqOf(commodoreId) + 1;
      // 삭제 도중 프로세스가 내려가도 남은 파일의 옛 줄을 읽지 않게 경계를 먼저 영속한다.
      const state = commit(commodoreId, { ...current, transcriptClearedThrough: clearedThrough }, "clear");
      lastSeq.set(commodoreId, clearedThrough);
      fs.rmSync(transcriptFile(commodoreId), { force: true });
      pruneImages(commodoreId);
      return state;
    },
    images,
    memory,
    transcriptAppend: (commodoreId, input) => append(commodoreId, input),
    transcriptRead(commodoreId, pageOptions) {
      const limit = Math.max(1, Math.min(MAX_TRANSCRIPT_PAGE, pageOptions?.limit ?? DEFAULT_PAGE));
      const clearedThrough = load(commodoreId).transcriptClearedThrough ?? 0;
      const entries = readTranscriptFile(transcriptFile(commodoreId)).filter((entry) => entry.seq > clearedThrough);
      const before = pageOptions?.before;
      const scoped = before === undefined ? entries : entries.filter((entry) => entry.seq < before);
      return { entries: scoped.slice(Math.max(0, scoped.length - limit)), hasMore: scoped.length > limit, clearedThrough };
    },
    askAdd(commodoreId, input) {
      const reason = input.reason.trim();
      if (!reason || reason.length > MAX_ASK_REASON) throw new CommodoreStoreError("invalid_request");
      const current = load(commodoreId);
      const asks = current.asks ?? [];
      // 저장될 모양 그대로 비교한다 — 같은 목표에 같은 질문이 서 있으면 다시 묻지 않는다.
      const shape = (questions: readonly AskQuestionInput[]) =>
        questions.map((question) => ({ ...(question.header ? { header: question.header } : {}), text: question.text, options: question.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })), multiSelect: question.options.length > 0 && question.multiSelect === true }));
      const objectiveId = input.objective?.id ?? null;
      const same = asks.find((ask) => !ask.settled && ask.objectiveId === objectiveId && isDeepStrictEqual(shape(ask.questions), shape(input.questions)));
      if (same) return { state: current, ask: same, reused: true };
      if (asks.filter((ask) => !ask.settled).length >= MAX_OPEN_ASKS) throw new CommodoreStoreError("too_many_asks", undefined, { limit: MAX_OPEN_ASKS });
      const ask: CommodoreAsk = {
        id: `a_${randomUUID()}`, at: now(), reason, objectiveId,
        questions: shape(input.questions).map((question) => ({ id: randomUUID(), ...question, options: question.options.map((option) => ({ id: randomUUID(), ...option })) })),
      };
      const state = commit(commodoreId, { ...current, asks: keptAsks([...asks, ask]) }, "asks");
      append(commodoreId, { kind: "ask", askId: ask.id, reason, questions: ask.questions.map((question) => ({ text: question.text, options: question.options.map((option) => option.label), multiSelect: question.multiSelect })), ...(input.objective ? { objective: { id: input.objective.id, title: input.objective.title.slice(0, 200) } } : {}) });
      return { state, ask, reused: false };
    },
    askWithdraw(commodoreId, askId) {
      const current = load(commodoreId);
      const ask = (current.asks ?? []).find((entry) => entry.id === askId);
      if (!ask) throw new CommodoreStoreError("unknown_ask");
      if (ask.settled?.outcome === "answered") throw new CommodoreStoreError("ask_already_answered");
      if (ask.settled) return { state: current, ask, withdrawn: false };
      const withdrawn: CommodoreAsk = { ...ask, settled: { at: now(), by: "commodore", outcome: "withdrawn" } };
      const state = commit(commodoreId, { ...current, asks: keptAsks((current.asks ?? []).map((entry) => (entry.id === askId ? withdrawn : entry))) }, "asks");
      return { state, ask: withdrawn, withdrawn: true };
    },
    askAnswer(commodoreId, askId, input) {
      const current = load(commodoreId);
      const ask = (current.asks ?? []).find((entry) => entry.id === askId);
      if (!ask) throw new CommodoreStoreError("unknown_ask");
      if (ask.settled?.outcome === "withdrawn") throw new CommodoreStoreError("ask_withdrawn");
      // 모든 질문에 정확히 한 번 — 고른 것은 그 질문의 선택지, 하나 고르기는 하나까지, 빈 답은 받지 않는다(결정 요청과 같은 규칙).
      const byQuestion = new Map(input.map((answer) => [answer.questionId, answer]));
      if (byQuestion.size !== input.length || input.length !== ask.questions.length) throw new CommodoreStoreError("invalid_answers");
      const answers = ask.questions.map((question) => {
        const answer = byQuestion.get(question.id);
        if (!answer) throw new CommodoreStoreError("invalid_answers");
        const picked = new Set(answer.selectedOptionIds);
        if (picked.size !== answer.selectedOptionIds.length || [...picked].some((id) => !question.options.some((option) => option.id === id)) || (!question.multiSelect && picked.size > 1)) throw new CommodoreStoreError("invalid_answers");
        if (picked.size === 0 && !answer.text.trim()) throw new CommodoreStoreError("invalid_answers");
        return { questionId: question.id, selectedOptionIds: question.options.filter((option) => picked.has(option.id)).map((option) => option.id), text: answer.text };
      });
      // 이미 답한 질문 — 같은 답의 재전송(응답을 잃은 재시도)은 그 결과를, 다른 답은 덮지 않고 거절한다.
      if (ask.settled) {
        if (!isDeepStrictEqual(ask.settled.answers, answers)) throw new CommodoreStoreError("ask_already_answered");
        return { state: current, ask, repeated: true };
      }
      const answered: CommodoreAsk = { ...ask, settled: { at: now(), by: "human", outcome: "answered", answers } };
      const state = commit(commodoreId, { ...current, asks: keptAsks((current.asks ?? []).map((entry) => (entry.id === askId ? answered : entry))) }, "asks");
      append(commodoreId, { kind: "ask-answered", askId, answers: askAnswerLines(answered) });
      return { state, ask: answered, repeated: false };
    },
    askRead(commodoreId, askIds) {
      const current = load(commodoreId);
      const unread = new Set(askIds);
      if (!(current.asks ?? []).some((ask) => unread.has(ask.id) && ask.settled?.outcome === "answered" && ask.readAt === undefined)) return current;
      const at = now();
      return commit(commodoreId, { ...current, asks: (current.asks ?? []).map((ask) => (unread.has(ask.id) && ask.settled?.outcome === "answered" && ask.readAt === undefined ? { ...ask, readAt: at } : ask)) }, "asks");
    },
    patrollingCommodores() {
      const ids = new Set<string>([...states.keys(), ...(options.commodoreIds?.() ?? [])]);
      const result: string[] = [];
      for (const commodoreId of ids) {
        try { if (patrolIntervalMs(load(commodoreId)) !== null) result.push(commodoreId); }
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
function foldCommodoreModels(state: CommodoreState): CommodoreState {
  const model = state.model ? canonicalModelId(state.model) : state.model;
  const commanderModel = state.commanderModel ? canonicalModelId(state.commanderModel) : state.commanderModel;
  if (model === state.model && commanderModel === state.commanderModel) return state;
  return { ...state, ...(model ? { model } : {}), ...(commanderModel ? { commanderModel } : {}) };
}

function readStateFile(file: string): CommodoreState {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_COMMODORE_STATE;
    throw error;
  }
  try {
    const { theaters: _theaters, ...state } = JSON.parse(raw);
    const parsed = commodoreStateSchema.safeParse(migrateCommodorePatrolState(state));
    if (parsed.success) return foldCommodoreModels(parsed.data);
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

function compactIfLarge(file: string): readonly CommodoreTranscriptEntry[] | undefined {
  let size: number;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size <= TRANSCRIPT_COMPACT_BYTES) return;
  const entries = readTranscriptFile(file);
  const kept = entries.slice(Math.floor(entries.length / 2));
  writeFileAtomic(file, kept.map((entry) => JSON.stringify(entry)).join("\n") + (kept.length ? "\n" : ""));
  return kept;
}

/** tmp→rename. tmp 는 매번 새 이름으로 배타 생성해 이미 있는 자리(특히 밖을 가리키는 링크)를 따라가며 쓰지 않는다. */
export function writeFileAtomic(file: string, data: string): void {
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

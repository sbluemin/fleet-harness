import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../store.js";
import {
  DEFAULT_TASKFORCE_LEDGER_PAGE,
  MAX_TASKFORCE_LEDGER_PAGE,
  MAX_TASKFORCE_IMAGE_BYTES,
  TASKFORCE_CHAIN_LIMIT,
  TASKFORCE_ID,
  taskforceLedgerEntrySchema,
  taskforceJudgingSnapshotSchema,
  taskforceStateSchema,
  type TaskforceAction,
  type TaskforceEvent,
  type TaskforceJudgingSnapshot,
  type TaskforceLedgerEntry,
  type TaskforceLedgerImage,
  type TaskforceSpeaker,
  type TaskforceState,
  type TaskforceStateChange,
  type TaskforceSummary,
  type TaskforceSystemCode,
} from "../../shared/contracts/taskforce.js";
import { TaskforceStoreError } from "./errors.js";

/**
 * TaskForce 저장소 — Console 데이터의 `taskforce/<TF UUID>/` 하나.
 *
 * ```
 * taskforce/<TF UUID>/state.json      TF 상태 한 건(성원·주제·chain·readSeq·lastSeq)
 * taskforce/<TF UUID>/ledger.jsonl    원장(한 줄 한 항목, seq 단조 증가, 덧붙이기만)
 * taskforce/<TF UUID>/images/<seq>/   원장 항목의 이미지 사본
 * ```
 *
 * Console이 유일한 쓰는 쪽이라 잠금도 감시도 없고, 상태 변경은 tmp→rename으로 쓰고
 * 원장은 덧붙인 뒤에야 캐시가 갈리고 마지막에 사건으로 방송한다. 보관 정책은 전부 보관 —
 * 원장을 줄이지 않는다(사령관 기록의 절반 압축과 다르다). TF 내용은 사령관 1:1 기록에
 * 절대 쓰지 않는다.
 *
 * chain 계산은 기록 정리다: 사령관 발언이면 +1, 사람 발언이면 0으로 돌리고 조용히 연다.
 * 12에 닿았을 때 멈추고 깨우는 일은 런타임(판단·깨움)의 몫이라 여기서 system 항목을
 * 덧붙이거나 깨우지 않는다. `continue` 만이 chain-resumed 항목을 남긴다.
 */

export interface TaskforceStoreOptions {
  /** `taskforce` 루트 — Console 데이터 디렉터리 아래. */
  readonly root: string;
  readonly emit: (event: TaskforceEvent) => void;
  readonly now?: () => number;
}

export interface TaskforceCreateInput {
  readonly name: string;
  readonly topic: string;
  readonly members: readonly string[];
}

export interface TaskforceAppendInput {
  readonly speaker: TaskforceSpeaker;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly replyTo?: number;
  readonly actions?: readonly TaskforceAction[];
  readonly images?: readonly TaskforceLedgerImage[];
}

export interface TaskforceImageUpload {
  readonly name: string;
  readonly mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly bytes: Uint8Array;
}

const STATE_FILE = "state.json";
const LEDGER_FILE = "ledger.jsonl";
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as const;

export interface TaskforceStore {
  /** 읽을 수 있는 TF — 재시작 복원이 읽는다. 폴더를 읽을 수 없는 자리는 빠진다. */
  availableTaskforces(): readonly string[];
  list(): readonly TaskforceSummary[];
  read(taskforceId: string): TaskforceState | null;
  lastEntry(taskforceId: string): TaskforceLedgerEntry | null;
  readLedger(taskforceId: string, options?: { readonly limit?: number; readonly before?: number }): { readonly entries: readonly TaskforceLedgerEntry[]; readonly hasMore: boolean };
  /** 성원 commodore가 아직 읽지 않은 항목 — 판단 턴이 싣는다. */
  pending(taskforceId: string, commodoreId: string): readonly TaskforceLedgerEntry[];
  create(input: TaskforceCreateInput): { readonly state: TaskforceState; readonly entry: TaskforceLedgerEntry };
  /** 사람·사령관의 말 — 닫힌 TF는 `taskforce_closed` 로 거절한다. */
  append(taskforceId: string, input: TaskforceAppendInput): { readonly state: TaskforceState; readonly entry: TaskforceLedgerEntry };
  /** 판단 턴이 성공한 뒤 부른다 — 읽은 위치를 전진시킨다. */
  advanceReadSeq(taskforceId: string, commodoreId: string, through: number): TaskforceState;
  update(taskforceId: string, input: { readonly name?: string; readonly topic?: string }): TaskforceState;
  addMembers(taskforceId: string, commodoreIds: readonly string[]): TaskforceState;
  removeMember(taskforceId: string, commodoreId: string): TaskforceState;
  /** 사령관 삭제가 부른다 — 속한 모든 TF에서 빼고 system 항목을 남긴다. */
  removeCommodoreFromAll(commodoreId: string): readonly string[];
  /** chain을 멈춘다 — 12번째 사령관 발언을 본 런타임이 `chain-paused` 항목과 함께 잠근다. */
  pauseChain(taskforceId: string): TaskforceState;
  /** 판단 스냅샷을 조용히 영속한다 — 읽을 때의 모습이다. 판단 사건 방송은 런타임이 따로 낸다. */
  saveJudging(taskforceId: string, snapshot: { readonly judging: readonly string[]; readonly outcomes: Readonly<Record<string, { readonly outcome: "spoke" | "silent" | "failed"; readonly at: number }>>; readonly at: number }): TaskforceState;
  /**
   * 보드 쓰기 묶음 — 같은 턴에 말한 사령관의 성공한 보드 쓰기를 그 말(`replyTo`) 아래에
   * 덧붙인다. chain을 건드리지 않고 렌더용으로만 방송한다(깨우지 않는다).
   */
  appendActions(taskforceId: string, commodoreId: string, input: { readonly actions: readonly TaskforceAction[]; readonly replyTo: number }): { readonly state: TaskforceState; readonly entry: TaskforceLedgerEntry } | null;
  /** chain을 돌리고 연다 — 멈췄거나 쌓인 수가 있을 때만 chain-resumed 항목을 남긴다. */
  continue(taskforceId: string): TaskforceState;
  close(taskforceId: string): TaskforceState;
  reopen(taskforceId: string): TaskforceState;
  /** 닫기 제안 — system 항목(`close-proposed`, 본문=사유, mentions=제안자)으로 남긴다. */
  proposeClose(taskforceId: string, commodoreId: string, reason: string): { readonly state: TaskforceState; readonly entry: TaskforceLedgerEntry };
  /** TF 디렉터리째 지운다 — 되돌릴 수 없는 삭제의 커밋점이다. */
  delete(taskforceId: string): void;
  saveImages(taskforceId: string, seq: number, images: readonly TaskforceImageUpload[]): readonly TaskforceLedgerImage[];
  readImage(taskforceId: string, seq: number, imageId: string): { readonly bytes: Buffer; readonly mime: TaskforceLedgerImage["mime"]; readonly name: string } | null;
  /** 같은 TF의 동시 post로 seq가 어긋났을 때 사본 디렉터리를 실제 seq로 옮긴다. */
  moveImages(taskforceId: string, fromSeq: number, toSeq: number): void;
  /** 우리가 둔 사본 파일만 거둔다 — append가 거절됐을 때의 되돌리기다. */
  removeImages(taskforceId: string, seq: number, imageIds: readonly string[]): void;
  forget(taskforceId: string): void;
  subscribe(listener: (event: TaskforceEvent) => void): () => void;
}

export function createTaskforceStore(options: TaskforceStoreOptions): TaskforceStore {
  const now = options.now ?? Date.now;
  const root = path.resolve(options.root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("taskforce_root_invalid");
  const base = fs.realpathSync.native(root);

  const states = new Map<string, TaskforceState>();
  const lastSeqs = new Map<string, number>();
  const lastEntries = new Map<string, TaskforceLedgerEntry | null>();
  const listeners = new Set<(event: TaskforceEvent) => void>();

  const broadcast = (event: TaskforceEvent) => {
    options.emit(event);
    for (const listener of listeners) {
      try { listener(event); } catch (error) { console.warn(`[objectives] taskforce listener failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  };

  /** 존재하지 않는 끝 경로도 실제 부모까지 풀어 검사한다. 링크로 보관소 밖을 읽거나 지우지 않는다. */
  const realPath = (file: string): string => {
    try { return fs.realpathSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(file);
      if (parent === file) throw error;
      return path.join(realPath(parent), path.basename(file));
    }
  };
  const contained = (dir: string, relative: string): string => {
    const basis = realPath(dir);
    const candidate = path.resolve(basis, relative);
    const inside = (file: string) => { const rel = path.relative(basis, file); return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
    if (!inside(candidate) || !inside(realPath(candidate))) throw new TaskforceStoreError("invalid_request");
    return candidate;
  };

  const dirOf = (taskforceId: string): string | null => {
    if (!TASKFORCE_ID.test(taskforceId)) return null;
    try {
      const dir = path.join(base, taskforceId);
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(dir) !== dir) return null;
      return dir;
    } catch { return null; }
  };
  const stateFile = (taskforceId: string): string => path.join(base, taskforceId, STATE_FILE);
  const ledgerFile = (taskforceId: string): string => path.join(base, taskforceId, LEDGER_FILE);

  const readStateFile = (taskforceId: string): TaskforceState | null => {
    let raw: string;
    try { raw = fs.readFileSync(stateFile(taskforceId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = taskforceStateSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.id === taskforceId) return parsed.data;
    } catch { /* 아래에서 치운다 */ }
    console.warn(`[objectives] taskforce state unreadable, set aside: ${taskforceId}`);
    try { fs.renameSync(stateFile(taskforceId), `${stateFile(taskforceId)}.broken-${Date.now()}-${randomUUID()}`); } catch { /* 치우지 못해도 빈자리로 간다 */ }
    return null;
  };

  /** 깨진 줄은 건너뛴다 — 원장은 보여 주는 것이지 상태가 아니라 한 줄의 손상이 전체를 막지 않는다. */
  const readLedgerFile = (taskforceId: string): TaskforceLedgerEntry[] => {
    let raw: string;
    try { raw = fs.readFileSync(ledgerFile(taskforceId), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: TaskforceLedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = taskforceLedgerEntrySchema.safeParse(JSON.parse(line));
        if (parsed.success) entries.push(parsed.data);
      } catch { /* 건너뛴다 */ }
    }
    return entries;
  };

  /** 상태 한 건을 검증해 쓰고, 성공한 뒤에만 캐시를 갈고 방송한다. */
  const commit = (taskforceId: string, next: TaskforceState, change: TaskforceStateChange): TaskforceState => {
    const parsed = taskforceStateSchema.safeParse(next);
    if (!parsed.success) throw new TaskforceStoreError("invalid_request");
    if (parsed.data.id !== taskforceId) throw new TaskforceStoreError("invalid_request");
    const file = stateFile(taskforceId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify(parsed.data));
    states.set(taskforceId, parsed.data);
    lastSeqs.set(taskforceId, parsed.data.lastSeq);
    broadcast({ op: "taskforce-state", taskforceId, state: parsed.data, change });
    return parsed.data;
  };

  const seqOf = (taskforceId: string): number => {
    const known = lastSeqs.get(taskforceId);
    if (known !== undefined) return known;
    const state = load(taskforceId);
    const entries = readLedgerFile(taskforceId);
    const seq = Math.max(state.lastSeq, entries.length ? entries[entries.length - 1]!.seq : 0);
    lastSeqs.set(taskforceId, seq);
    return seq;
  };

  const load = (taskforceId: string): TaskforceState => {
    const cached = states.get(taskforceId);
    if (cached) return cached;
    const state = readStateFile(taskforceId);
    if (!state) throw new TaskforceStoreError("unknown_taskforce");
    states.set(taskforceId, state);
    return state;
  };

  /**
   * 원장 append — seq를 찍어 덧붙이고 lastSeq·chain·화자의 readSeq를 전진시킨 뒤
   * 원장 사건과 상태 사건(`ledger`)을 순서대로 낸다. 닫힌 TF의 말은 system 항목만
   * 다는 내부 경로(`appendSystem`)로 남긴다.
   */
  const appendEntry = (taskforceId: string, input: TaskforceAppendInput, { closedOk = false }: { readonly closedOk?: boolean } = {}): { state: TaskforceState; entry: TaskforceLedgerEntry } => {
    const current = load(taskforceId);
    if (!closedOk && current.status !== "open") throw new TaskforceStoreError("taskforce_closed");
    if (input.speaker.kind === "commodore" && !current.members.includes(input.speaker.commodoreId)) throw new TaskforceStoreError("invalid_request");
    const mentions = [...new Set(input.mentions ?? [])];
    if (mentions.some((id) => !current.members.includes(id))) throw new TaskforceStoreError("invalid_request");
    if (input.replyTo !== undefined && (input.replyTo < 1 || input.replyTo > current.lastSeq)) throw new TaskforceStoreError("invalid_request");
    if (input.speaker.kind !== "system" && !input.text.trim() && !(input.actions?.length)) throw new TaskforceStoreError("invalid_request");
    const entry = { ...input, mentions, seq: seqOf(taskforceId) + 1, at: now() } as TaskforceLedgerEntry;
    const parsed = taskforceLedgerEntrySchema.safeParse(entry);
    if (!parsed.success) throw new TaskforceStoreError("invalid_request");
    const file = ledgerFile(taskforceId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
    lastSeqs.set(taskforceId, parsed.data.seq);
    lastEntries.set(taskforceId, parsed.data);
    const chain = input.speaker.kind === "person"
      ? { count: 0, limit: TASKFORCE_CHAIN_LIMIT, paused: false }
      : input.speaker.kind === "commodore"
        ? { count: current.chain.count + 1, limit: TASKFORCE_CHAIN_LIMIT, paused: current.chain.paused }
        : current.chain;
    const readSeq = input.speaker.kind === "commodore"
      ? { ...current.readSeq, [input.speaker.commodoreId]: parsed.data.seq }
      : current.readSeq;
    // 말 수 — system 항목은 세지 않고, 보드 쓰기 묶음(빈 본문)도 세지 않는다.
    const baseCounts = current.counts ?? { person: 0, commodore: 0 };
    const counts = input.speaker.kind !== "system" && input.text.trim()
      ? { ...baseCounts, [input.speaker.kind]: baseCounts[input.speaker.kind] + 1 }
      : baseCounts;
    const next: TaskforceState = { ...current, chain, readSeq, counts, lastSeq: parsed.data.seq };
    const validated = taskforceStateSchema.parse(next);
    writeFileAtomic(stateFile(taskforceId), JSON.stringify(validated));
    states.set(taskforceId, validated);
    lastSeqs.set(taskforceId, validated.lastSeq);
    broadcast({ op: "taskforce-ledger", taskforceId, entry: parsed.data });
    broadcast({ op: "taskforce-state", taskforceId, state: validated, change: "ledger" });
    return { state: validated, entry: parsed.data };
  };

  /** system 항목 — 닫힌 TF에도 남는다(종료·재열기·퇴장 자체가 system 항목이다). */
  const appendSystem = (taskforceId: string, code: TaskforceSystemCode, text: string, mentions: readonly string[] = []): { state: TaskforceState; entry: TaskforceLedgerEntry } =>
    appendEntry(taskforceId, { speaker: { kind: "system", code }, text, mentions }, { closedOk: true });

  const summaryOf = (state: TaskforceState): TaskforceSummary => {
    const preview = lastEntries.get(state.id) ?? readLedgerFile(state.id).at(-1) ?? null;
    if (preview !== undefined && preview !== null) lastEntries.set(state.id, preview);
    return {
      id: state.id, name: state.name, topic: state.topic, members: [...state.members],
      status: state.status, lastSeq: state.lastSeq, createdAt: state.createdAt,
      counts: { ...(state.counts ?? { person: 0, commodore: 0 }) },
      judging: [...(state.judging?.judging ?? [])],
      ...(state.closedAt !== undefined ? { closedAt: state.closedAt } : {}),
      ...(preview ? { preview: { seq: preview.seq, at: preview.at, text: preview.text, speaker: preview.speaker } } : {}),
    };
  };

  const availableTaskforces = (): readonly string[] => {
    let names: string[];
    try { names = fs.readdirSync(base); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names.filter((name) => TASKFORCE_ID.test(name) && readStateFile(name) !== null).sort();
  };
  const forget = (taskforceId: string) => { states.delete(taskforceId); lastSeqs.delete(taskforceId); lastEntries.delete(taskforceId); };

  const storeRef: TaskforceStore = {
    availableTaskforces,
    list() { return availableTaskforces().map((id) => summaryOf(load(id))); },
    read(taskforceId) {
      try { return load(taskforceId); }
      catch (error) {
        if (error instanceof TaskforceStoreError && error.code === "unknown_taskforce") return null;
        throw error;
      }
    },
    lastEntry(taskforceId) {
      const known = lastEntries.get(taskforceId);
      if (known !== undefined) return known;
      load(taskforceId);
      const last = readLedgerFile(taskforceId).at(-1) ?? null;
      lastEntries.set(taskforceId, last);
      return last;
    },
    readLedger(taskforceId, pageOptions) {
      load(taskforceId);
      const limit = Math.max(1, Math.min(MAX_TASKFORCE_LEDGER_PAGE, pageOptions?.limit ?? DEFAULT_TASKFORCE_LEDGER_PAGE));
      const entries = readLedgerFile(taskforceId);
      const before = pageOptions?.before;
      const scoped = before === undefined ? entries : entries.filter((entry) => entry.seq < before);
      return { entries: scoped.slice(Math.max(0, scoped.length - limit)), hasMore: scoped.length > limit };
    },
    pending(taskforceId, commodoreId) {
      const state = load(taskforceId);
      const through = state.readSeq[commodoreId] ?? 0;
      return readLedgerFile(taskforceId).filter((entry) => entry.seq > through);
    },
    create(input) {
      const members = [...new Set(input.members)];
      if (members.length < 2 || input.members.length !== members.length) throw new TaskforceStoreError("invalid_request");
      const name = input.name.trim();
      const topic = input.topic.trim();
      if (!name || !topic) throw new TaskforceStoreError("invalid_request");
      const id = randomUUID();
      if (!TASKFORCE_ID.test(id)) throw new TaskforceStoreError("invalid_request");
      const dir = path.join(base, id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const state: TaskforceState = {
        id, name, topic, members, status: "open", createdAt: now(),
        readSeq: Object.fromEntries(members.map((member) => [member, 0])),
        chain: { count: 0, limit: TASKFORCE_CHAIN_LIMIT, paused: false },
        lastSeq: 0,
        counts: { person: 0, commodore: 0 },
      };
      commit(id, state, "created");
      // 만드는 말(주제)이 곧 `created` 항목이다 — 모든 성원이 판단 대상이다.
      return { state: load(id), entry: appendSystem(id, "created", topic).entry };
    },
    append: (taskforceId, input) => appendEntry(taskforceId, input),
    advanceReadSeq(taskforceId, commodoreId, through) {
      const current = load(taskforceId);
      const next = Math.max(current.readSeq[commodoreId] ?? 0, Math.min(Math.floor(through), current.lastSeq));
      if (next === (current.readSeq[commodoreId] ?? 0)) return current;
      return commit(taskforceId, { ...current, readSeq: { ...current.readSeq, [commodoreId]: next } }, "read");
    },
    update(taskforceId, input) {
      const current = load(taskforceId);
      const name = input.name?.trim();
      const topic = input.topic?.trim();
      if ((name !== undefined && !name) || (topic !== undefined && !topic)) throw new TaskforceStoreError("invalid_request");
      const next: TaskforceState = {
        ...current,
        ...(name !== undefined && name !== current.name ? { name } : {}),
        ...(topic !== undefined && topic !== current.topic ? { topic } : {}),
      };
      if (next.name === current.name && next.topic === current.topic) return current;
      return commit(taskforceId, next, "updated");
    },
    addMembers(taskforceId, commodoreIds) {
      const current = load(taskforceId);
      const fresh = [...new Set(commodoreIds)];
      if (!fresh.length || fresh.length !== commodoreIds.length) throw new TaskforceStoreError("invalid_request");
      if (fresh.some((id) => current.members.includes(id))) throw new TaskforceStoreError("invalid_request");
      const members = [...current.members, ...fresh];
      if (members.length > 32) throw new TaskforceStoreError("invalid_request");
      const committed = commit(taskforceId, {
        ...current, members,
        readSeq: { ...current.readSeq, ...Object.fromEntries(fresh.map((member) => [member, current.lastSeq])) },
      }, "member-added");
      // 새로 든 성원은 이미 쌓인 말을 다시 판단하지 않는다 — readSeq를 끝으로 둔다.
      appendSystem(taskforceId, "member-added", "", fresh);
      return load(taskforceId) ?? committed;
    },
    removeMember(taskforceId, commodoreId) {
      const current = load(taskforceId);
      if (!current.members.includes(commodoreId)) throw new TaskforceStoreError("invalid_request");
      const committed = commit(taskforceId, {
        ...current,
        members: current.members.filter((member) => member !== commodoreId),
        readSeq: Object.fromEntries(Object.entries(current.readSeq).filter(([member]) => member !== commodoreId)),
      }, "member-removed");
      appendSystem(taskforceId, "member-removed", "", [commodoreId]);
      return load(taskforceId) ?? committed;
    },
    removeCommodoreFromAll(commodoreId) {
      const touched: string[] = [];
      for (const id of availableTaskforces()) {
        try {
          if (load(id).members.includes(commodoreId)) { storeRef.removeMember(id, commodoreId); touched.push(id); }
        } catch { /* 읽을 수 없는 TF는 다음 기회가 다시 본다 */ }
      }
      return touched;
    },
    saveJudging(taskforceId, snapshot) {
      const current = load(taskforceId);
      const judging = taskforceJudgingSnapshotSchema.safeParse({
        judging: [...snapshot.judging].filter((member) => current.members.includes(member)).sort(),
        outcomes: { ...snapshot.outcomes },
        at: snapshot.at,
      });
      if (!judging.success) throw new TaskforceStoreError("invalid_request");
      // 판단 스냅샷은 읽을 때의 모습이라 사건으로 방송하지 않는다 — 판단 사건이 따로 나간다.
      const validated = taskforceStateSchema.parse({ ...current, judging: judging.data });
      writeFileAtomic(stateFile(taskforceId), JSON.stringify(validated));
      states.set(taskforceId, validated);
      return validated;
    },
    pauseChain(taskforceId) {      const current = load(taskforceId);
      if (current.status !== "open") throw new TaskforceStoreError("taskforce_closed");
      if (current.chain.paused) return current;
      commit(taskforceId, { ...current, chain: { ...current.chain, paused: true } }, "ledger");
      appendSystem(taskforceId, "chain-paused", "");
      return load(taskforceId);
    },
    appendActions(taskforceId, commodoreId, input) {
      const current = load(taskforceId);
      // 턴이 끝나기 전에 TF가 닫혔으면 묶음을 버린다 — 말 자체는 이미 원장에 있다.
      if (current.status !== "open") return null;
      if (!current.members.includes(commodoreId) || !input.actions.length) throw new TaskforceStoreError("invalid_request");
      if (input.replyTo < 1 || input.replyTo > current.lastSeq) throw new TaskforceStoreError("invalid_request");
      const entry = { speaker: { kind: "commodore", commodoreId } as const, text: "", mentions: [] as string[], actions: [...input.actions], replyTo: input.replyTo, seq: seqOf(taskforceId) + 1, at: now() };
      const parsed = taskforceLedgerEntrySchema.safeParse(entry);
      if (!parsed.success) throw new TaskforceStoreError("invalid_request");
      const file = ledgerFile(taskforceId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o600 });
      fs.appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, { mode: 0o600 });
      lastSeqs.set(taskforceId, parsed.data.seq);
      lastEntries.set(taskforceId, parsed.data);
      // chain은 건드리지 않는다 — 이것은 말이 아니라 같은 턴의 보드 쓰기 묶음이다.
      const readSeq = { ...current.readSeq, [commodoreId]: Math.max(current.readSeq[commodoreId] ?? 0, parsed.data.seq) };
      const validated = taskforceStateSchema.parse({ ...current, readSeq, lastSeq: parsed.data.seq });
      writeFileAtomic(stateFile(taskforceId), JSON.stringify(validated));
      states.set(taskforceId, validated);
      lastSeqs.set(taskforceId, validated.lastSeq);
      broadcast({ op: "taskforce-ledger", taskforceId, entry: parsed.data });
      broadcast({ op: "taskforce-state", taskforceId, state: validated, change: "ledger" });
      return { state: validated, entry: parsed.data };
    },
    continue(taskforceId) {
      const current = load(taskforceId);
      if (current.status !== "open") throw new TaskforceStoreError("taskforce_closed");
      if (!current.chain.paused && current.chain.count === 0) return current;
      commit(taskforceId, { ...current, chain: { count: 0, limit: TASKFORCE_CHAIN_LIMIT, paused: false } }, "continued");
      appendSystem(taskforceId, "chain-resumed", "");
      return load(taskforceId);
    },
    close(taskforceId) {
      const current = load(taskforceId);
      if (current.status === "closed") return current;
      commit(taskforceId, { ...current, status: "closed", closedAt: now() }, "closed");
      appendSystem(taskforceId, "closed", "");
      return load(taskforceId);
    },
    reopen(taskforceId) {
      const current = load(taskforceId);
      if (current.status === "open") return current;
      const { closedAt: _closedAt, ...rest } = current;
      commit(taskforceId, { ...rest, status: "open" }, "reopened");
      appendSystem(taskforceId, "reopened", "");
      return load(taskforceId);
    },
    proposeClose(taskforceId, commodoreId, reason) {
      const current = load(taskforceId);
      if (current.status !== "open") throw new TaskforceStoreError("taskforce_closed");
      if (!current.members.includes(commodoreId)) throw new TaskforceStoreError("invalid_request");
      const text = reason.trim();
      if (!text) throw new TaskforceStoreError("invalid_request");
      return appendSystem(taskforceId, "close-proposed", text, [commodoreId]);
    },
    delete(taskforceId) {
      load(taskforceId);
      const dir = dirOf(taskforceId);
      if (!dir || path.dirname(dir) !== base) throw new TaskforceStoreError("unknown_taskforce");
      fs.rmSync(dir, { recursive: true, force: true });
      forget(taskforceId);
      broadcast({ op: "taskforce-removed", taskforceId });
    },
    saveImages(taskforceId, seq, images) {
      load(taskforceId);
      if (!images.length || images.length > 4) throw new TaskforceStoreError("invalid_request");
      const seen = new Set<string>();
      const dir = contained(path.join(base, taskforceId), `images/${seq}`);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const saved: TaskforceLedgerImage[] = [];
      try {
        for (const image of images) {
          if (!(image.mime in EXTENSIONS) || image.bytes.byteLength > MAX_TASKFORCE_IMAGE_BYTES) throw new TaskforceStoreError("invalid_request");
          const id = randomUUID();
          if (seen.has(id)) throw new TaskforceStoreError("invalid_request");
          seen.add(id);
          fs.writeFileSync(contained(dir, `${id}.${EXTENSIONS[image.mime]}`), image.bytes, { flag: "wx", mode: 0o600 });
          saved.push({ id, mime: image.mime, name: image.name, size: image.bytes.byteLength });
        }
      } catch (error) {
        for (const item of saved) {
          for (const extension of Object.values(EXTENSIONS)) {
            try { fs.unlinkSync(contained(dir, `${item.id}.${extension}`)); } catch { /* 다음 정리 때 다시 거둔다 */ }
          }
        }
        throw error;
      }
      return saved;
    },
    moveImages(taskforceId, fromSeq, toSeq) {
      if (fromSeq === toSeq) return;
      load(taskforceId);
      const from = contained(path.join(base, taskforceId), `images/${fromSeq}`);
      const to = contained(path.join(base, taskforceId), `images/${toSeq}`);
      try {
        if (!fs.lstatSync(from).isDirectory() || fs.lstatSync(from).isSymbolicLink()) return;
      } catch { return; }
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(from)) {
        const source = contained(from, name);
        try {
          if (!fs.lstatSync(source).isFile()) continue;
          fs.renameSync(source, contained(to, name));
        } catch { /* 다음 정리가 다시 본다 */ }
      }
      try { fs.rmdirSync(from); } catch { /* 비지 않았으면 둔다 */ }
    },
    removeImages(taskforceId, seq, imageIds) {
      if (!imageIds.length) return;
      let dir: string;
      try { dir = contained(path.join(base, taskforceId), `images/${seq}`); }
      catch { return; }
      for (const imageId of imageIds) {
        for (const extension of Object.values(EXTENSIONS)) {
          try { fs.unlinkSync(contained(dir, `${imageId}.${extension}`)); } catch { /* 없으면 그만 */ }
        }
      }
      try { fs.rmdirSync(dir); } catch { /* 남은 파일이 있으면 둔다 */ }
    },
    readImage(taskforceId, seq, imageId) {
      if (!TASKFORCE_ID.test(taskforceId)) return null;
      try {
        const dir = contained(path.join(base, taskforceId), `images/${seq}`);
        for (const [mime, extension] of Object.entries(EXTENSIONS)) {
          const file = contained(dir, `${imageId}.${extension}`);
          let fd: number;
          try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_TASKFORCE_IMAGE_BYTES) return null;
            return { bytes: fs.readFileSync(fd), mime: mime as TaskforceLedgerImage["mime"], name: `${imageId}.${extension}` };
          } finally { fs.closeSync(fd); }
        }
      } catch { /* 사본이 없거나 안전하게 읽을 수 없으면 회수된 자리다. */ }
      return null;
    },
    forget,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return storeRef;
}

export type { TaskforceLedgerImage as TaskforceStoredImage };

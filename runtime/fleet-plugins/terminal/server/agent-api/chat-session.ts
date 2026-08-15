import { promises as fs } from "node:fs";
import path from "node:path";

import {
  createClaudeGatewaySdk,
  type ClaudeGatewayEffort,
  type ClaudeGatewayMessage,
  type ClaudeGatewaySdk,
} from "@dotobokuri/core-agent/claude";

import { chatEventsFromSdkMessage, chatReplayFromTranscriptLine, type AgentChatJournalEvent, type AgentChatStreamEvent } from "./chat-events.js";
import type { AgentProviderSession } from "./types.js";

/**
 * Chat Mode 세션 하나의 서버 소유 상태.
 *
 * PTY가 없다 — 같은 Claude 세션을 core-agent SDK가 격리 config dir에서 이어받아 돌린다.
 * 원 세션의 트랜스크립트는 생성 시 격리 dir로 복사돼 resume의 근거가 되고(스파이크로 실증),
 * 매 턴이 끝나면 원 projects 디렉터리로 되쓴다 — Console 재시작·터미널 복귀(--resume)·
 * Session Analyst가 전부 그 원본 경로 하나를 계속 권위로 삼게 하기 위해서다.
 */

/**
 * 이 세션이 어디서 시작하는가. 두 길은 대칭이 아니다 — `resume`은 이미 있는 트랜스크립트가
 * 세션 id와 projects 디렉터리 이름을 **둘 다** 말해 주지만, `fresh`는 아직 아무것도 없어서
 * 그 둘을 SDK가 첫 턴에 만들어 준 뒤에야 알 수 있다.
 *
 * `fresh`가 아는 것은 되쓸 뿌리 하나뿐이다. cwd → projects 디렉터리 이름의 인코딩 규칙은
 * 여기서도 재구현하지 않는다: SDK가 자기 격리 dir 안에 만든 디렉터리 이름을 그대로 읽어
 * 같은 이름으로 뿌리 아래에 내려놓는다(resume이 원 경로의 부모 이름을 그대로 쓰는 것과 같은 규율).
 */
export type AgentChatSessionOrigin =
  | { readonly kind: "resume"; readonly transcriptPath: string }
  | { readonly kind: "fresh"; readonly transcriptRoot: string };

export interface AgentChatSessionSeed {
  readonly baseUrl: string;
  readonly model: string;
  readonly effort?: ClaudeGatewayEffort;
  readonly cwd: string;
  readonly origin: AgentChatSessionOrigin;
  readonly onProviderSessionUpdate: (providerSession: AgentProviderSession) => void;
  /**
   * 이 세션의 실행 활동을 Operation 활동축에 보고한다. 반환 false는 축이 이 보고를 받지 못했다는
   * 뜻이며, 그때는 턴을 시작하지 않는다 — 배선이 끊긴 채 도는 턴은 화면에 휴면으로 보이고,
   * 그 조용한 거짓말이 이 계약이 존재하는 이유다.
   */
  readonly reportActivity: (working: boolean) => boolean;
  /**
   * 활동축이 이 세션의 보고를 받을 수 있는지 묻기만 한다 — 아무것도 쓰지 않는다.
   * 쓰는 프로브는 진행 중 턴을 유휴로 뒤집고 그 전이를 방송해, 첫 턴이 도는 중에 들어온
   * 두 번째 메시지가 조기 턴 종료 신호를 만든다.
   */
  readonly canReportActivity: () => boolean;
}

/** 테스트가 실 SDK 스폰 없이 레지스트리를 돌리기 위한 주입점. */
export type CreateChatSdk = (options: {
  readonly baseUrl: string;
  readonly models: readonly string[];
}) => Promise<ClaudeGatewaySdk>;

const JOURNAL_CAP = 2_000;
const TOOL_NAME_CAP = 500;

class AgentChatSession {
  readonly operationId: string;
  private readonly seed: AgentChatSessionSeed;
  private readonly createSdk: CreateChatSdk;
  private sdk: ClaudeGatewaySdk | null = null;
  private sdkFlight: Promise<ClaudeGatewaySdk> | null = null;
  /**
   * resume 좌표는 트랜스크립트 파일명이 말하는 세션 id다 — 캡처 id는 드리프트할 수 있다.
   * `fresh`는 아직 세션이 없으므로 null로 출발하고, 첫 SDK 메시지의 session_id가 이 자리를 채운다.
   */
  private latestSessionId: string | null;
  private journal: AgentChatJournalEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(event: AgentChatJournalEvent) => void>();
  private turnFlight: Promise<void> = Promise.resolve();
  private pendingTurns = 0;
  private disposed = false;
  /**
   * tool_use id → 도구 이름. 결과 블록은 자기가 어떤 도구의 결말인지 모르는데, 무엇을 요약해도
   * 되는지는 도구가 정한다(읽기·쓰기 계열의 성공 결과는 내용이라 싣지 않는다). 긴 세션에서
   * 무한히 자라지 않게 상한을 두고 오래된 것부터 버린다 — 결과는 호출 직후에 오므로 잃을 게 없다.
   */
  private readonly toolNames = new Map<string, string>();

  constructor(operationId: string, seed: AgentChatSessionSeed, createSdk: CreateChatSdk) {
    this.operationId = operationId;
    this.seed = seed;
    this.createSdk = createSdk;
    this.latestSessionId = seed.origin.kind === "resume"
      ? path.basename(seed.origin.transcriptPath, ".jsonl")
      : null;
  }

  get busy(): boolean {
    return this.pendingTurns > 0;
  }

  async replayTranscript(): Promise<void> {
    // 채팅으로 태어난 세션에는 되돌려줄 과거가 없다 — 빈 리플레이는 "읽지 못했다"와 다르므로
    // 오류 이벤트도 내지 않고, 로그는 첫 턴부터 자란다.
    if (this.seed.origin.kind === "fresh") return;
    const transcriptPath = this.seed.origin.transcriptPath;
    this.push({ kind: "replay-start" });
    let turns = 0;
    // 재생 턴의 소요 시간은 트랜스크립트가 이미 들고 있다 — 디스패치 줄과 그 턴 마지막 줄의
    // 시각 차이다. 이것이 없으면 접힘 줄이 과거 턴에서만 시간을 잃는다.
    let turnAt: number | null = null;
    let lastAt: number | null = null;
    const closeReplayedTurn = (): void => {
      if (turnAt !== null && lastAt !== null && lastAt > turnAt) {
        this.push({ kind: "turn-end", ok: true, durationMs: lastAt - turnAt });
      }
      turnAt = null;
      lastAt = null;
    };
    try {
      const raw = await fs.readFile(transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        const mapped = chatReplayFromTranscriptLine(line, { cwd: this.seed.cwd, toolNames: this.toolNames });
        for (const event of mapped.events) {
          if (event.kind === "dispatch") {
            closeReplayedTurn();
            turns += 1;
            turnAt = mapped.at ?? null;
          }
          this.rememberTool(event);
          this.push(event);
        }
        if (mapped.events.length > 0 && mapped.at !== undefined) lastAt = mapped.at;
      }
      closeReplayedTurn();
    } catch {
      // 트랜스크립트를 읽지 못해도 세션은 계속된다 — 로그가 비어 보일 뿐 새 턴은 돌 수 있다.
      this.push({ kind: "error", code: "chat_replay_unavailable" });
    }
    this.push({ kind: "replay-end", turns });
  }

  /** 저널 전체를 되돌려준 뒤 라이브 이벤트를 흘린다. 반환값은 구독 해제다. */
  subscribe(listener: (event: AgentChatJournalEvent) => void): () => void {
    for (const entry of this.journal) listener(entry);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 턴을 직렬화해 실행한다. 반환은 큐 등록 시점이다 — 진행·실패는 저널 이벤트로 전달된다.
   * 실패한 턴은 반드시 run.close()로 슬롯을 반납한다(스파이크에서 실증한 함정).
   */
  /**
   * 활동축이 이 세션의 턴을 받을 수 있는지 미리 확인한다. 큐에 넣은 뒤에는 HTTP 응답이 이미
   * 떠났으므로, 거절은 요청 경계에서만 시끄러울 수 있다.
   */
  canReportActivity(): boolean {
    return this.seed.canReportActivity();
  }

  send(text: string): void {
    if (this.disposed) return;
    this.pendingTurns += 1;
    this.turnFlight = this.turnFlight
      .then(() => this.runTurn(text))
      .catch(() => undefined)
      .finally(() => {
        this.pendingTurns -= 1;
      });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // SDK를 먼저 접는다 — dispose가 활성 런을 close해 진행 중 턴을 끊는다. 순서를 뒤집어
    // 턴 완주를 먼저 기다리면, 멈춘 턴 하나가 Operation 삭제·Console 셧다운을 무기한 막는다.
    const sdk = this.sdk;
    this.sdk = null;
    if (sdk) await sdk.dispose().catch(() => undefined);
    await this.turnFlight.catch(() => undefined);
    this.listeners.clear();
  }

  /** 도구 이벤트가 지나갈 때 id→이름을 적어 둔다. 결과 요약 정책이 이 축 위에서 결정된다. */
  private rememberTool(event: AgentChatStreamEvent): void {
    if (event.kind !== "tool" && event.kind !== "tool-start") return;
    if (event.id === undefined) return;
    this.toolNames.set(event.id, event.name);
    if (this.toolNames.size > TOOL_NAME_CAP) {
      const oldest = this.toolNames.keys().next();
      if (!oldest.done) this.toolNames.delete(oldest.value);
    }
  }

  private push(event: AgentChatStreamEvent): void {
    const entry: AgentChatJournalEvent = { seq: ++this.seq, event };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_CAP) this.journal.splice(0, this.journal.length - JOURNAL_CAP);
    for (const listener of this.listeners) listener(entry);
  }

  /**
   * 라이브 구독자에게만 흘리고 저널에는 남기지 않는다 — 글자 단위 델타를 저널(cap 2000)에
   * 쌓으면 즉시 소진된다. 재접속 리플레이는 완성 text 이벤트(병합본)로 같은 내용을 복원하고,
   * 그 완성 이벤트가 델타 유실의 정정 앵커를 겸한다. seq는 저널과 한 축을 공유한다.
   */
  private pushEphemeral(event: AgentChatStreamEvent): void {
    const entry: AgentChatJournalEvent = { seq: ++this.seq, event };
    for (const listener of this.listeners) listener(entry);
  }

  private async ensureSdk(): Promise<ClaudeGatewaySdk> {
    if (this.sdk) return this.sdk;
    if (!this.sdkFlight) {
      this.sdkFlight = (async () => {
        const sdk = await this.createSdk({ baseUrl: this.seed.baseUrl, models: [this.seed.model] });
        try {
          await this.copyTranscriptIntoConfigDir(sdk.configDir);
        } catch (error) {
          await sdk.dispose().catch(() => undefined);
          throw error;
        }
        if (this.disposed) {
          await sdk.dispose().catch(() => undefined);
          throw new Error("chat session disposed");
        }
        this.sdk = sdk;
        return sdk;
      })().finally(() => {
        this.sdkFlight = null;
      });
    }
    return this.sdkFlight;
  }

  /**
   * 원 트랜스크립트를 격리 config dir의 같은 projects/<인코딩된 cwd>/ 아래로 복사한다.
   * 인코딩 규칙을 재구현하지 않는다 — 원 경로의 부모 디렉터리 이름이 곧 그 인코딩이다.
   * 채팅으로 태어난 세션에는 복사할 원본이 없다 — SDK가 자기 dir 안에 스스로 만든다.
   */
  private async copyTranscriptIntoConfigDir(configDir: string): Promise<void> {
    if (this.seed.origin.kind === "fresh") return;
    const projectDirName = path.basename(path.dirname(this.seed.origin.transcriptPath));
    const dest = path.join(configDir, "projects", projectDirName, `${this.latestSessionId}.jsonl`);
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fs.copyFile(this.seed.origin.transcriptPath, dest);
  }

  private async runTurn(text: string): Promise<void> {
    if (this.disposed) return;
    this.push({ kind: "dispatch", text, at: Date.now() });
    this.push({ kind: "turn-start", at: Date.now() });
    // 활동 보고가 먼저다. 실패하면 SDK를 부르지 않는다 — 턴이 도는데 축이 휴면이라고 말하는
    // 상태를 만들지 않기 위해, 여기서는 일을 시작하지 않는 쪽을 고른다.
    if (!this.seed.reportActivity(true)) {
      this.push({ kind: "error", code: "chat_activity_unavailable" });
      this.push({ kind: "turn-end", ok: false });
      return;
    }
    let sawResult = false;
    try {
      const sdk = await this.ensureSdk();
      const run = await sdk.startTurn({
        prompt: text,
        model: this.seed.model,
        ...(this.seed.effort ? { effort: this.seed.effort } : {}),
        cwd: this.seed.cwd,
        // 채팅으로 태어난 세션의 첫 턴에는 이어붙일 좌표가 없다 — resume 없이 시작하고,
        // SDK가 돌려주는 session_id가 그 자리를 채운다(그다음 턴부터는 resume이 선다).
        ...(this.latestSessionId ? { resume: this.latestSessionId } : {}),
        permissionMode: "bypassPermissions",
        // 스트리밍 감각의 근거 — 글자 단위 text_delta를 받으려면 부분 메시지가 필요하다.
        includePartialMessages: true,
      });
      try {
        for await (const message of run as AsyncIterable<ClaudeGatewayMessage>) {
          if (typeof message.session_id === "string" && message.session_id.length > 0) {
            this.latestSessionId = message.session_id;
          }
          for (const event of chatEventsFromSdkMessage(message, { cwd: this.seed.cwd, toolNames: this.toolNames })) {
            if (event.kind === "turn-end") sawResult = true;
            this.rememberTool(event);
            // tool-start는 완성 tool 이벤트가 같은 스텝을 다시 세우므로 저널에 남기지 않는다 —
            // 남기면 재접속 리플레이에서 좌표 없는 빈 스텝이 한 줄 더 선다.
            if (event.kind === "text-delta" || event.kind === "tool-start") this.pushEphemeral(event);
            else this.push(event);
          }
        }
      } finally {
        // 정상 소진이면 no-op, 도중 이탈이면 슬롯 반납 — 없으면 다음 턴이 영영 막힌다.
        run.close();
      }
      if (!sawResult) this.push({ kind: "turn-end", ok: true });
      await this.writeBackTranscript();
    } catch {
      this.push({ kind: "error", code: "chat_turn_failed" });
      if (!sawResult) this.push({ kind: "turn-end", ok: false });
    } finally {
      this.seed.reportActivity(false);
    }
  }

  /**
   * 격리 dir에서 자란 트랜스크립트를 원 projects 디렉터리로 되쓴다. 우리 사본은 원본에서
   * 출발했으므로 길이가 원본 이상일 때만 덮어쓴다 — 외부에서 자란 원본을 지우지 않는 경계다.
   */
  private async writeBackTranscript(): Promise<void> {
    const sdk = this.sdk;
    // 세션 id가 없으면 되쓸 파일 이름조차 없다 — 첫 턴이 session_id 없이 끝난 경우다.
    if (!sdk || !this.latestSessionId) return;
    const sessionId = this.latestSessionId;
    const projectDirName = await this.resolveProjectDirName(sdk.configDir);
    if (!projectDirName) return;
    const source = path.join(sdk.configDir, "projects", projectDirName, `${sessionId}.jsonl`);
    const sourceStat = await fs.stat(source).catch(() => null);
    if (!sourceStat?.isFile()) return;
    const destDir = this.seed.origin.kind === "resume"
      ? path.dirname(this.seed.origin.transcriptPath)
      : path.join(this.seed.origin.transcriptRoot, projectDirName);
    const dest = path.join(destDir, `${sessionId}.jsonl`);
    const destStat = await fs.stat(dest).catch(() => null);
    if (destStat?.isFile() && destStat.size > sourceStat.size) return;
    // 복사가 실패하면 providerSession을 갱신하지 않는다 — 존재하지 않는 파일을 durable 권위로
    // 가리키면 터미널 복귀·재시작·Analyst가 조용히 턴을 잃는다. 실패는 저널로 표면화한다.
    try {
      // 채팅으로 태어난 세션은 이 디렉터리를 처음 만든다. resume 경로에서는 만들지 않는다 —
      // 그쪽에서 목적지가 사라졌다면 원본이 밖에서 치워진 것이고, 되살려 쓰는 것은 그 삭제를
      // 조용히 되돌리는 일이다. 실패를 저널로 표면화하는 기존 계약을 그대로 둔다.
      if (this.seed.origin.kind === "fresh") await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
      await fs.copyFile(source, dest);
    } catch {
      this.push({ kind: "error", code: "chat_writeback_failed" });
      return;
    }
    this.seed.onProviderSessionUpdate({
      provider: "claude",
      sessionId,
      transcriptPath: dest,
      source: "chat-mode",
      capturedAt: new Date().toISOString(),
    });
  }

  /**
   * 이 세션의 트랜스크립트가 앉은 projects 디렉터리 이름. resume은 원 경로가 이미 말해 주고,
   * fresh는 SDK가 자기 dir 안에 만든 이름을 읽는다 — cwd 인코딩 규칙을 재구현하지 않기 위해서다.
   * 격리 dir은 이 세션 전용이라 그 아래 projects 항목은 하나뿐이며, 여럿이면 무엇이 우리 것인지
   * 말할 수 없으므로 되쓰지 않는다(잘못된 뿌리에 남의 세션을 심는 것보다 낫다).
   */
  private async resolveProjectDirName(configDir: string): Promise<string | null> {
    if (this.seed.origin.kind === "resume") return path.basename(path.dirname(this.seed.origin.transcriptPath));
    const entries = await fs.readdir(path.join(configDir, "projects"), { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    const dirs = entries.filter((entry) => entry.isDirectory());
    return dirs.length === 1 ? dirs[0]?.name ?? null : null;
  }
}

export class AgentChatRegistry {
  private readonly sessions = new Map<string, AgentChatSession>();
  private readonly ensureFlights = new Map<string, Promise<AgentChatSession>>();
  /** dispose 진행 중 tombstone — 이 창에서의 ensure 재진입이 두 번째 필자를 만든다. */
  private readonly disposals = new Map<string, Promise<void>>();
  private readonly createSdk: CreateChatSdk;

  constructor(createSdk: CreateChatSdk = (options) => createClaudeGatewaySdk(options)) {
    this.createSdk = createSdk;
  }

  has(operationId: string): boolean {
    return this.sessions.has(operationId);
  }

  isBusy(operationId: string): boolean {
    return this.sessions.get(operationId)?.busy === true;
  }

  /** 세션이 없으면 만들고 트랜스크립트를 재생한다. 동시 진입은 한 생성으로 수렴한다. */
  async ensure(operationId: string, seed: () => AgentChatSessionSeed): Promise<AgentChatSession> {
    // dispose가 진행 중이면 새 세션을 만들지 않는다 — 터미널 복귀와 경합해 같은 Claude 세션의
    // 이중 필자가 되는 창이다. 호출자(스트림·메시지 라우트)는 chat_unavailable로 답한다.
    if (this.disposals.has(operationId)) throw new Error("chat_session_disposing");
    const existing = this.sessions.get(operationId);
    if (existing) return existing;
    const inFlight = this.ensureFlights.get(operationId);
    if (inFlight) return inFlight;
    const flight = (async () => {
      const session = new AgentChatSession(operationId, seed(), this.createSdk);
      await session.replayTranscript();
      this.sessions.set(operationId, session);
      return session;
    })().finally(() => {
      this.ensureFlights.delete(operationId);
    });
    this.ensureFlights.set(operationId, flight);
    return flight;
  }

  get(operationId: string): AgentChatSession | undefined {
    return this.sessions.get(operationId);
  }

  async dispose(operationId: string): Promise<void> {
    const pending = this.disposals.get(operationId);
    if (pending) return pending;
    // tombstone은 동기로 먼저 세운다 — 이후 도착하는 ensure는 전부 거부되고, 이미 in-flight인
    // 생성은 완주를 기다린 뒤 접는다. 그냥 돌아가면 DELETE가 터미널을 되살린 뒤에 pending
    // ensure가 chat 세션을 등록해 같은 Claude 세션의 이중 필자가 된다.
    const disposal = (async () => {
      const flight = this.ensureFlights.get(operationId);
      if (flight) await flight.then(() => undefined, () => undefined);
      const session = this.sessions.get(operationId);
      if (!session) return;
      this.sessions.delete(operationId);
      await session.dispose();
    })();
    this.disposals.set(operationId, disposal);
    try {
      await disposal;
    } finally {
      this.disposals.delete(operationId);
    }
  }

  async disposeAll(): Promise<void> {
    const operationIds = new Set([...this.sessions.keys(), ...this.ensureFlights.keys()]);
    await Promise.all([...operationIds].map((operationId) => this.dispose(operationId)));
  }
}

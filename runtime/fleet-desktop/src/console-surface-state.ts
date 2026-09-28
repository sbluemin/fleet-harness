/**
 * 창이 지금 어느 콘솔을 보여 주는가 — 그 사실의 유일한 주인.
 *
 * 로컬 뷰는 이 앱이 띄운 콘솔을 그리고 창과 함께 산다. 다른 콘솔은 데이터 뷰에 그린다. 권한(화면 캡처,
 * 클립보드, 창 명령, 단축키, 포커스, Operation 브라우저)은 안정된 상태의 활성 뷰 하나만 갖고, 전환 중에는
 * 누구도 갖지 않는다.
 *
 *   local-ready ──신뢰 선택──▶ quiescing ──떠남 답──▶ preparing ──준비 표식──▶ remote-ready
 *        ▲                        │답 없음                │실패                      │세션 끝남
 *        └─ 확인 성공 ◀ committing-local ◀─┴──────────────────────┴───── disconnected ◀──────┘
 *                            │확인 실패
 *                            └──▶ disconnected(local_unavailable) — 로컬 화면은 보이지만 권한은 없다
 *
 * 로컬로 돌아오는 일은 둘로 나뉜다. 로컬 화면을 앞에 세우는 것은 곧바로 하고, 권한(캡처·창 명령·브라우저)을
 * 돌려주는 것은 관리 중인 콘솔과 그 문서가 지금도 맞는지 확인한 뒤에만 한다.
 *
 * 전환은 번호(세대)를 갖는다. 새 선택이나 복귀가 오면 세대가 오르고, 앞선 시도는 늦게 끝나도 상태를 건드리지 않는다.
 */

export type ConsoleSurfaceState = "local-ready" | "quiescing" | "preparing" | "remote-ready" | "committing-local" | "disconnected";

export interface SurfaceSelection {
  readonly origin: string;
  /** 고른 화면이 실어 보낸 주소 — 그 콘솔 안의 화면, 또는 표현 상태 fragment. */
  readonly url?: string;
}

export interface SwitchAttempt {
  readonly generation: number;
  isCurrent(): boolean;
}

export interface ConsoleSurfaceDeps {
  readonly localOrigin: () => string | null;
  /** 로컬 뷰에게 떠난다고 알리고 그 뷰의 답을 기다린다. 답이 없거나 늦으면 던진다. */
  readonly quiesceLocal: (attempt: SwitchAttempt) => Promise<void>;
  /** 데이터 뷰에 그 콘솔을 싣고, 도착과 준비 표식을 확인할 때까지 기다린다. */
  readonly prepareData: (selection: SurfaceSelection, attempt: SwitchAttempt) => Promise<void>;
  /** 전환 중에는 창 명령·브라우저 뷰가 어느 콘솔의 것도 아니다. */
  readonly suspendOwners: () => void;
  /** 데이터 뷰를 앞에 세우고 동기화기를 그 콘솔로 옮긴다. */
  readonly presentData: (origin: string) => void;
  /**
   * 로컬 뷰를 앞에 세우고 데이터 뷰를 비운 뒤, 관리 중인 콘솔과 로컬 문서가 지금도 맞는지 확인한다. 확인하지
   * 못하면 던진다. 이 시도가 옛것이 되면 결과는 버려진다.
   */
  readonly presentLocal: (attempt: SwitchAttempt) => Promise<void>;
  /** 로컬이 권한을 되찾았다 — 동기화기를 로컬로 옮긴다. 확인이 성공한 뒤에만 불린다. */
  readonly adoptLocal: () => void;
  /** 최종 떠남에서만 — 그 원격의 자기 세션을 끝내 달라고 한 번 청한다. 페어링은 남는다. */
  readonly endRemoteSession: (origin: string) => void;
  readonly report: (error: unknown) => void;
  readonly notify: (reason: DisconnectReason) => void;
  readonly log: (message: string) => void;
}

export type DisconnectReason = "expired" | "unavailable" | "crashed" | "local_unavailable";

export interface ConsoleSurface {
  state(): ConsoleSurfaceState;
  generation(): number;
  /** remote-ready에서 데이터 뷰가 보여 주는 콘솔. */
  remoteOrigin(): string | null;
  /** 신뢰할 수 있는 입력(검증된 피커, 활성 로컬 main frame, 네이티브 메뉴·링크)에서만 부른다. */
  select(selection: SurfaceSelection): Promise<void>;
  /** 신뢰할 수 있는 입력에서만 부른다. */
  returnLocal(): Promise<void>;
  /** 데이터 뷰가 오류 문서에 착지했거나 렌더러를 잃었다. */
  disconnect(reason: DisconnectReason): Promise<void>;
  /** 창이 닫혔다. 서 있던 원격은 최종 떠남이고, 다음 창은 로컬에서 시작한다. */
  reset(): void;
}

export function createConsoleSurface(deps: ConsoleSurfaceDeps): ConsoleSurface {
  let state: ConsoleSurfaceState = "local-ready";
  let generation = 0;
  let remote: string | null = null;
  /** 로컬 뷰가 이미 떠남에 답했는가. 로컬로 돌아오기 전까지는 다시 묻지 않는다(원격 → 원격 전환). */
  let localQuiesced = false;

  const transition = (next: ConsoleSurfaceState, reason?: string): void => {
    deps.log(`surface ${state} -> ${next} generation=${generation}${reason ? ` reason=${reason}` : ""}`);
    state = next;
  };

  const begin = (): SwitchAttempt => {
    const mine = ++generation;
    return { generation: mine, isCurrent: () => generation === mine };
  };

  /** 로컬 화면을 되돌리고, 확인이 성공했을 때만 권한을 되돌린다. 권한을 되찾았으면 true. */
  async function restoreLocal(attempt: SwitchAttempt, reason: string): Promise<boolean> {
    remote = null;
    deps.suspendOwners();
    transition("committing-local", reason);
    try {
      await deps.presentLocal(attempt);
    } catch (error) {
      if (!attempt.isCurrent()) return false;
      // 확인하지 못한 로컬에는 권한을 돌려주지 않는다. 화면은 로컬이지만 캡처·창 명령·브라우저는 닫혀 있다.
      transition("disconnected", "local_unavailable");
      deps.log(`local console not confirmed: ${error instanceof Error ? error.message.slice(0, 64) : "unknown"}`);
      deps.notify("local_unavailable");
      return false;
    }
    if (!attempt.isCurrent()) return false;
    localQuiesced = false;
    transition("local-ready", reason);
    deps.adoptLocal();
    return true;
  }

  async function select(selection: SurfaceSelection): Promise<void> {
    const home = deps.localOrigin();
    if (home !== null && selection.origin === home) return returnLocal();
    if (state === "remote-ready" && selection.origin === remote) return;
    const attempt = begin();
    const leaving = state === "remote-ready" ? remote : null;
    try {
      if (!localQuiesced) {
        transition("quiescing");
        await deps.quiesceLocal(attempt);
        if (!attempt.isCurrent()) return;
        localQuiesced = true;
      }
      transition("preparing");
      deps.suspendOwners();
      await deps.prepareData(selection, attempt);
      if (!attempt.isCurrent()) return;
      remote = selection.origin;
      transition("remote-ready");
      deps.presentData(selection.origin);
      // 옛 원격은 여기서 끝났다 — 데이터 뷰는 이미 다른 콘솔을 싣고 있다.
      if (leaving !== null && leaving !== selection.origin) deps.endRemoteSession(leaving);
    } catch (error) {
      if (!attempt.isCurrent()) return;
      deps.report(error);
      const reason = state === "quiescing" ? "quiesce_failed" : "prepare_failed";
      await restoreLocal(attempt, reason);
      if (leaving !== null && leaving !== selection.origin) deps.endRemoteSession(leaving);
    }
  }

  async function returnLocal(): Promise<void> {
    if (state === "local-ready") return;
    const leaving = state === "remote-ready" ? remote : null;
    const attempt = begin();
    await restoreLocal(attempt, "return");
    if (leaving !== null) deps.endRemoteSession(leaving);
  }

  async function disconnect(reason: DisconnectReason): Promise<void> {
    // 준비 중의 실패는 그 시도가 스스로 거둔다. 여기서는 이미 서 있던 원격만 본다.
    if (state !== "remote-ready") return;
    const attempt = begin();
    transition("disconnected", reason);
    // 세션이 이미 끝났으므로 끝내 달라고 청할 것이 없다. 오류 문서에는 돌아갈 길이 없으므로 로컬로 되돌린다.
    const restored = await restoreLocal(attempt, `disconnected_${reason}`);
    // 로컬도 확인하지 못했다면 그 알림이 이미 나갔다 — 두 번 말하지 않는다.
    if (restored) deps.notify(reason);
  }

  return {
    state: () => state,
    generation: () => generation,
    remoteOrigin: () => (state === "remote-ready" ? remote : null),
    select,
    returnLocal,
    disconnect,
    reset() {
      const leaving = state === "remote-ready" ? remote : null;
      begin();
      remote = null;
      localQuiesced = false;
      transition("local-ready", "window_closed");
      if (leaving !== null) deps.endRemoteSession(leaving);
    },
  };
}

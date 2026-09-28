/**
 * 창의 native 주인 — 테마·갱신·창 명령·Operation 브라우저·전체화면이 어느 콘솔을 따르는가.
 *
 * 주인이 되는 일은 여러 번 기다리는 일이다(각 동기화기가 그 콘솔에 붙기까지). 그 사이 사람이 로컬로 돌아오거나
 * 다른 콘솔을 고르면, 앞선 콘솔의 체인은 늦게 끝나더라도 그 뒤 단계를 시작해서는 안 된다 — 그러면 화면은 로컬인데
 * 창 명령과 브라우저 제어는 떠난 원격이 쥔다. 그래서 체인의 매 단계 앞에서 "아직 이 시도가 최신이고, 이 콘솔이
 * 지금 권한을 가진 콘솔인가"를 다시 묻고, 명령을 실제로 적용하는 순간에도 한 번 더 묻는다.
 */

export interface OwnerSynchronizer {
  start(origin: string): Promise<void>;
  stop(): void;
}

export interface ConsoleOwnerDeps {
  /** 지금 native 권한을 가진 콘솔. 전환 중이거나 권한 없는 화면이면 null. */
  readonly currentOwner: () => string | null;
  readonly theme: (origin: string) => Promise<void>;
  readonly supervisedUpdates: (origin: string) => Promise<void>;
  readonly shellUpdates: (origin: string) => Promise<void>;
  readonly windowCommands: OwnerSynchronizer;
  readonly browserViews: OwnerSynchronizer;
  readonly fullscreen: (origin: string) => void;
  readonly log?: (message: string) => void;
}

export interface ConsoleOwners {
  /** 그 콘솔을 창의 주인으로 붙인다. 기다리는 사이 주인이 바뀌면 남은 단계는 시작하지 않는다. */
  follow(origin: string): Promise<void>;
  /** 전환이 시작됐다 — 진행 중인 체인을 무효로 하고, 창 명령과 브라우저 제어를 누구의 것도 아니게 한다. */
  suspend(): void;
  /** 이 콘솔에서 온 창 명령·브라우저 제어를 지금 적용해도 되는가. */
  mayCommand(origin: string | null): boolean;
  /** 창 명령을 맡긴 콘솔이 지금도 권한을 가진 콘솔인가. 명령을 적용하는 순간에 묻는다. */
  holdsCommands(): boolean;
}

export function createConsoleOwners(deps: ConsoleOwnerDeps): ConsoleOwners {
  let attempt = 0;
  /** 창 명령과 브라우저 제어를 맡긴 콘솔. 체인이 그 단계에 닿았을 때만 정해진다. */
  let commandOwner: string | null = null;

  const suspend = (): void => {
    attempt += 1;
    commandOwner = null;
    deps.windowCommands.stop();
    deps.browserViews.stop();
  };

  return {
    suspend,

    mayCommand: (origin) => origin !== null && commandOwner === origin && deps.currentOwner() === origin,
    holdsCommands: () => commandOwner !== null && deps.currentOwner() === commandOwner,

    async follow(origin) {
      const mine = ++attempt;
      const live = (): boolean => mine === attempt && deps.currentOwner() === origin;
      const abandoned = (step: string): boolean => {
        if (live()) return false;
        deps.log?.(`console owner chain abandoned before ${step}`);
        return true;
      };
      if (abandoned("theme")) return;
      await deps.theme(origin);
      if (abandoned("updates")) return;
      await deps.supervisedUpdates(origin);
      if (abandoned("shell updates")) return;
      await deps.shellUpdates(origin);
      if (abandoned("window commands")) return;
      commandOwner = origin;
      await deps.windowCommands.start(origin);
      if (abandoned("browser views")) return;
      await deps.browserViews.start(origin);
      if (abandoned("fullscreen")) return;
      deps.fullscreen(origin);
    },
  };
}

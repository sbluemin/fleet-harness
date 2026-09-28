import type { WebContents } from "electron";

import type { SwitchAttempt } from "./console-surface-state.js";
import type { ProxyBroker, ProxyEpoch } from "./proxy-broker-client.js";
import type { ProxyDataSurface, ProxyDataViews } from "./proxy-data-view.js";
import type { DesktopShellWindow } from "./shell-window.js";

/**
 * 조인한 원격을 읽기 전용 격리 뷰(A′)로 보여 줄지, 직결(B1)로 보여 줄지 가르고, A′의 수명을 끝까지 쥔다.
 *
 * 신뢰할 수 있는 선택 하나에 조인은 한 번뿐이고 그것은 이미 끝났다. 여기서는 그 세션으로 원격의 등급과 버전을
 * 묻고, monitoring이면서 같은 버전일 때만 그 포트의 세션 쿠키 하나를 broker에 위임한다. 그 밖의 경우, 또는
 * 격리를 세우거나 확인하지 못한 경우는 같은 세션으로 직결한다 — 다시 조인하지 않는다.
 *
 * 끝내는 순서는 늘 같다: 뷰를 봉인해 요청과 입력을 막고, broker에 그 epoch을 끝내라고 한 뒤(끝난 이유가 broker라면
 * 생략), 뷰를 닫고 partition을 비우고 확인한다.
 */

export interface ProxyTarget {
  readonly origin: string;
  readonly hostId: string;
  readonly pinGeneration: number;
  readonly port: number;
  readonly sessionCookieName: string;
  /** 표현 상태 fragment(있다면). */
  readonly carry: string;
}

export interface ProxyPresentationDeps {
  readonly enabled: () => boolean;
  readonly broker: ProxyBroker;
  readonly views: ProxyDataViews;
  readonly shell: () => DesktopShellWindow | null;
  /** 창의 쿠키 항아리에서 그 이름의 값을 읽는다. 위임 직전에만 읽고 들고 있지 않는다. */
  readonly readSessionCookie: (origin: string, name: string) => Promise<string | null>;
  /** 조인한 세션으로 원격의 등급과 버전을 묻는다. 모르면 null. */
  readonly probeRemote: (origin: string) => Promise<{ readonly access: string | null; readonly version: string | null }>;
  readonly localVersion: () => Promise<string | null>;
  readonly cover: (url: string, views: { readonly from: WebContents; readonly to: WebContents }, load: () => Promise<void>) => Promise<void>;
  readonly log?: (message: string) => void;
}

export interface ActiveProxy {
  readonly remoteOrigin: string;
  readonly epochId: string;
  readonly generation: number;
  readonly contents: WebContents;
}

export interface ProxyPresentation {
  /** A′로 실었으면 true, 직결해야 하면 false. 실패는 던진다. */
  tryPresent(target: ProxyTarget, attempt: SwitchAttempt): Promise<boolean>;
  active(): ActiveProxy | null;
  /**
   * 활성 epoch을 끝낸다. `final`: 사람이 떠났다(broker가 원격 세션을 한 번 끝내 달라고 청한다).
   * `terminal`: broker가 이미 끝냈다. `local_failure`: 이 뷰가 스스로 무너졌다.
   */
  end(mode: "final" | "terminal" | "local_failure"): Promise<void>;
  /** broker가 알린 끝이 지금 보이는 epoch의 것인가. */
  isActive(epochId: string, generation: number): boolean;
}

interface Active extends ActiveProxy {
  readonly surface: ProxyDataSurface;
  readonly epoch: ProxyEpoch;
}

export function createProxyPresentation(deps: ProxyPresentationDeps): ProxyPresentation {
  let current: Active | null = null;

  async function dispose(surface: ProxyDataSurface, epoch: Pick<ProxyEpoch, "epochId" | "generation">, discard: "final" | "transfer" | null): Promise<void> {
    surface.seal();
    if (discard !== null) await deps.broker.discard(epoch, discard);
    try {
      await surface.teardown();
    } catch (error) {
      deps.log?.(`proxy teardown failed: ${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      try { deps.shell()?.stack.unmountProxyView(surface.view); } catch { /* 창이 먼저 닫혔다. */ }
    }
  }

  return {
    active: () => current,
    isActive: (epochId, generation) => current !== null && current.epochId === epochId && current.generation === generation,

    async tryPresent(target, attempt) {
      if (!deps.enabled() || deps.views.unusable()) return false;
      // 등급과 버전은 broker도 다시 확인한다. 여기서는 위임할 가치가 있는지만 가른다.
      const [remote, local] = await Promise.all([deps.probeRemote(target.origin), deps.localVersion()]);
      if (remote.access !== "monitoring") {
        deps.log?.(`proxy branch: direct access=${remote.access ?? "unknown"}`);
        return false;
      }
      if (remote.version === null || local === null || remote.version !== local) {
        deps.log?.("proxy branch: direct version_mismatch");
        return false;
      }
      if (!attempt.isCurrent()) throw new Error("surface_switch_superseded");
      const value = await deps.readSessionCookie(target.origin, target.sessionCookieName);
      if (value === null) throw new Error("remote_host_session_expired");
      const result = await deps.broker.delegate({
        switchGeneration: attempt.generation,
        hostId: target.hostId,
        pinGeneration: target.pinGeneration,
        session: { name: target.sessionCookieName, value },
      });
      if (result.kind === "direct") {
        deps.log?.(`proxy branch: direct ${result.reason}`);
        return false;
      }
      const { epoch } = result;
      if (!attempt.isCurrent()) {
        await deps.broker.discard(epoch, "final");
        throw new Error("surface_switch_superseded");
      }

      let surface: ProxyDataSurface;
      try {
        surface = await deps.views.open(epoch);
      } catch (error) {
        // 격리를 세우거나 확인하지 못했다. 같은 세션을 직결로 넘긴다 — 원격 세션은 끝내지 않는다.
        deps.log?.(`proxy branch: direct isolation ${error instanceof Error ? error.message : "unknown"}`);
        await deps.broker.discard(epoch, "transfer");
        return false;
      }
      const shell = deps.shell();
      if (!shell || shell.isDestroyed()) {
        await dispose(surface, epoch, "final");
        throw new Error("remote_bridge_no_window");
      }
      shell.stack.mountProxyView(surface.view);
      try {
        await deps.cover(epoch.origin, { from: shell.activeContents(), to: surface.contents }, async () => {
          // 덮개 아래에서 앞으로 세운다. 권한은 이 뷰에 가지 않는다 — 격리 뷰는 어떤 권한도 받지 않는다.
          shell.stack.activateSurface("proxy");
          await surface.load(`${epoch.origin}/console/${target.carry}`);
        });
      } catch (error) {
        await dispose(surface, epoch, "final");
        throw error;
      }
      if (!attempt.isCurrent()) {
        await dispose(surface, epoch, "final");
        throw new Error("surface_switch_superseded");
      }
      const previous = current;
      current = { remoteOrigin: target.origin, epochId: epoch.epochId, generation: epoch.generation, contents: surface.contents, surface, epoch };
      deps.log?.(`proxy epoch presented epoch=${epoch.epochId}`);
      // 앞서 보던 격리 뷰는 여기서 끝났다(최종 떠남). owner는 새 epoch이 쓰고 있으므로 반납하지 않는다.
      if (previous) await dispose(previous.surface, previous.epoch, "final");
      return true;
    },

    async end(mode) {
      const ending = current;
      if (!ending) return;
      current = null;
      await dispose(ending.surface, ending.epoch, mode === "terminal" ? null : "final");
      // epoch이 없는 owner를 붙들고 있지 않는다. 다음 A′는 새 lease로 시작한다.
      await deps.broker.release();
    },
  };
}

import type { WebContentsView } from "electron";

import type { EntryFarewell, EntryPageSnapshot, EntryPageWebContents } from "./entry-page.js";
import type { EntryLanguage } from "./launch-controller.js";
import type { DesktopShellWindow } from "./shell-window.js";

/**
 * 종료 인사 — 진입 화면의 넘겨주기를 거꾸로 돌린다.
 *
 * 종료가 시작되면 Console 위에 진입 화면을 한 겹 더 얹는다. 덮개는 투명한 판에서 마크와 워드마크가
 * Console 상단 브랜드 자리에 앉은 모습으로 시작하고, 바탕이 차오르는 동안 둘이 가운데로 돌아와
 * "종료 중"을 말한다. 판이 차오른 뒤에 Console을 멈추고, 정지가 끝나면 창이 흐려지며 사라진다.
 *
 * 덮개는 Console을 대신하지 않는다. 아래의 Console은 끝까지 그 자리에 있으므로 정지에 실패하면
 * 덮개만 걷으면 원래 화면이 그대로 돌아온다. 그리고 덮개가 어떤 이유로든 뜨지 못해도 종료는
 * 막히지 않는다 — 인사는 종료의 부가 동작이지 조건이 아니다.
 */

export interface QuitFarewellDependencies {
  /** 인사를 얹을 창. Console을 보여 주고 있지 않으면 null — 진입 화면 위에 또 진입 화면을 얹지 않는다. */
  readonly shell: () => DesktopShellWindow | null;
  /** 샌드박스·Node 없는 투명 뷰. 항해 울타리는 여기서 친다. */
  readonly createView: () => WebContentsView;
  readonly entryPagePath: string;
  readonly snapshot: (phase: EntryFarewell) => EntryPageSnapshot;
  readonly pushEntry: (contents: EntryPageWebContents, snapshot: EntryPageSnapshot) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface QuitFarewell {
  /** stop을 인사와 함께 돌린다. stop의 실패는 덮개를 걷은 뒤 그대로 올려 보낸다. */
  run(stop: () => Promise<void>): Promise<void>;
}

/** 마크가 가운데로 돌아와 "종료 중"을 읽을 수 있을 만큼 머무는 최소 시간. entry.css `--handoff-duration`(420ms)을 품는다. */
export const FAREWELL_MIN_MS = 900;
/** 마크가 가운데로 돌아오는 시간 — entry.css `--handoff-duration`(420ms)과 종료 인사의 지연(60ms). */
const FAREWELL_RETURN_MS = 480;
/** 마지막에 창 전체가 흐려지는 시간. */
export const FAREWELL_FADE_MS = 180;
/** 덮개를 띄우는 데 이보다 오래 걸리면 기다리지 않는다 — 인사 때문에 종료가 늦어지지 않게. */
const FAREWELL_SHOW_TIMEOUT_MS = 600;
/** 판이 차오르는 시간 — entry.css `--duration-fade`와 짝. */
const FAREWELL_VEIL_MS = 200;
/** 투명한 덮개가 한 번 합성된 뒤에 전환을 시작해야 첫 프레임이 Console과 겹친다. */
const FAREWELL_FIRST_FRAME_MS = 34;

interface Veil {
  /** 판이 떴으면 그 사실을, 뜨지 못했으면 null. */
  readonly ready: Promise<Shown | null>;
  /** 언제 불러도 판을 걷는다. 아직 준비 중이면 뜨지 못하게 막는다. */
  dismiss(): void;
}

interface Shown {
  readonly reduced: boolean;
  /** 마크가 가운데로 돌아오기 시작한 시각. */
  readonly shownAt: number;
}

export function createQuitFarewell(deps: QuitFarewellDependencies): QuitFarewell {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function raise(shell: DesktopShellWindow): Veil {
    const view = deps.createView();
    const contents = view.webContents;
    let dismissed = false;
    const layout = (): void => { try { view.setBounds(shell.stack.layoutConsole()); } catch { /* 창이 먼저 닫혔다. */ } };
    const dismiss = (): void => {
      if (dismissed) return;
      dismissed = true;
      try { shell.base.off("resize", layout); } catch { /* 이미 사라진 창. */ }
      try { if (!shell.isDestroyed()) shell.stack.removeVeil(view); } catch { /* 창이 먼저 닫혔다. */ }
      try { contents.close(); } catch { /* 이미 죽은 렌더러. */ }
    };
    const gone = (): boolean => dismissed || shell.isDestroyed();
    const ready = (async (): Promise<Shown | null> => {
      try {
        layout();
        await contents.loadFile(deps.entryPagePath);
        if (gone()) return null;
        // Console과 같은 배율로 그려야 상단 브랜드 자리가 정확히 겹친다.
        try { contents.setZoomFactor(shell.consoleContents.getZoomFactor()); } catch { /* 배율은 부가 정보다. */ }
        let reduced = false;
        try { reduced = await contents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches") === true; } catch { /* 모르면 전환이 도는 쪽 */ }
        await deps.pushEntry(contents, deps.snapshot("veiled"));
        if (gone()) return null;
        shell.stack.presentVeil(view);
        shell.base.on("resize", layout);
        await sleep(FAREWELL_FIRST_FRAME_MS);
        if (gone()) return null;
        await deps.pushEntry(contents, deps.snapshot("shown"));
        return gone() ? null : { reduced, shownAt: now() };
      } catch (error) {
        deps.log?.(`quit farewell could not be shown: ${error instanceof Error ? error.message : String(error)}`);
        dismiss();
        return null;
      }
    })();
    return { ready, dismiss };
  }

  async function fadeWindow(shell: DesktopShellWindow): Promise<void> {
    const started = now();
    while (!shell.isDestroyed()) {
      const progress = Math.min(1, (now() - started) / FAREWELL_FADE_MS);
      try { shell.base.setOpacity((1 - progress) ** 3); } catch { return; }
      if (progress >= 1) return;
      await sleep(16);
    }
  }

  return {
    async run(stop) {
      const shell = deps.shell();
      if (!shell || shell.isDestroyed() || !shell.base.isVisible() || shell.base.isMinimized()) {
        await stop();
        return;
      }
      const started = now();
      const veil = raise(shell);
      // 판이 차오르기 전에 Console을 멈추면 아래 화면이 "연결 끊김"으로 바뀌는 모습이 비친다. 그래서 판이
      // 차오른 뒤에 멈추되, 인사가 늦으면 걷고 기다리지 않는다 — 인사가 종료를 늦추는 상한은 띄우기 제한과 판 시간이다.
      const farewell = await Promise.race([veil.ready, sleep(FAREWELL_SHOW_TIMEOUT_MS).then(() => null)]);
      if (!farewell) veil.dismiss();
      else if (!farewell.reduced) await sleep(FAREWELL_VEIL_MS);
      try {
        await stop();
      } catch (error) {
        veil.dismiss();
        throw error;
      }
      if (!farewell || farewell.reduced) return;
      // 창이 흐려지기 전에 마크가 가운데에 닿아 있어야 한다 — 판이 늦게 떴으면 그만큼 늦춘다.
      const settleAt = Math.max(started + FAREWELL_MIN_MS, farewell.shownAt + FAREWELL_RETURN_MS);
      const remaining = settleAt - now();
      if (remaining > 0) await sleep(remaining);
      await fadeWindow(shell);
    },
  };
}

const FAREWELL_TITLE: Record<EntryLanguage, string> = { ko: "Fleet 종료 중…", en: "Quitting Fleet…" };

/** 인사 화면은 한 줄만 말한다 — 태그라인·버전·개발 배지는 비운다. */
export function farewellSnapshot(lang: EntryLanguage, phase: EntryFarewell): EntryPageSnapshot {
  return { platform: process.platform, lang, dev: false, tagline: "", tone: "busy", title: FAREWELL_TITLE[lang], versions: "", farewell: phase };
}

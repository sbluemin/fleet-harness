import type { EntryPageSnapshot, EntryPageWebContents, EntryTone } from "./entry-page.js";

export type RuntimeEntryState = "checking" | "node" | "installing" | "offline" | "firstfail" | "starting" | "dev";

/** 오프라인 진입의 이유. 업데이트 설치가 실패했는지, 조회 자체가 닿지 않았는지를 가른다. */
export type OfflineReason = "install-failed" | "unreachable";

export type EntryLanguage = "ko" | "en";

export interface LaunchWindow {
  isDestroyed?(): boolean;
  loadURL(url: string): Promise<void>;
  show(): void;
  webContents: EntryPageWebContents & { navigationHistory: { clear(): void } };
}

export interface LaunchControllerDependencies {
  readonly createWindow: () => Promise<LaunchWindow>;
  readonly handoffOrigin: (origin: string) => void;
  readonly synchronizeTheme?: (origin: string) => Promise<void>;
  readonly synchronizeFullscreen?: (origin: string) => void | Promise<void>;
  readonly onConsoleLoaded?: () => void;
  readonly pushEntry: (contents: EntryPageWebContents, snapshot: EntryPageSnapshot) => Promise<void>;
  readonly startOrAdopt: () => Promise<string>;
  readonly dev?: boolean;
  readonly lang?: EntryLanguage;
  readonly desktopVersion?: string;
  /** 지금 설치돼 있는 관리형 Console 버전. 모르면 null — 버전 줄에서 뺀다. */
  readonly consoleVersion?: () => string | null;
  /** 넘겨주기 전 브랜드가 상단 자리로 줄어드는 전환을 기다린다. 기본은 settleEntryHandoff. */
  readonly settleHandoff?: (contents: EntryPageWebContents) => Promise<void>;
  readonly onFirstRunFailure?: () => Promise<boolean>;
  readonly onWindowReady?: (push: (state: RuntimeEntryState, detail?: string, progress?: number) => Promise<void>) => void;
}

export interface LaunchController { start(): Promise<LaunchWindow>; }

/**
 * 진입 CSS의 넘겨주기 전환(entry.css `--handoff-duration`)과 맞춘 대기. 이 시간 안에 문서를
 * 바꾸면 줄어들던 마크가 중간에서 멈춘 채 Console이 그려진다.
 */
export const HANDOFF_SETTLE_MS = 460;

/**
 * 동작 줄이기가 켜져 있으면 진입 CSS가 전환을 없애므로 기다릴 것이 없다 — 그 설정은 진입 렌더러의
 * 미디어 쿼리가 가장 정확히 안다. 묻지 못하면 전환이 도는 쪽으로 보고 기다린다.
 */
export async function settleEntryHandoff(contents: EntryPageWebContents): Promise<void> {
  let reduced = false;
  try { reduced = await contents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches") === true; } catch { /* 렌더러가 답하지 못하면 기본 대기 */ }
  if (!reduced) await new Promise<void>((resolve) => setTimeout(resolve, HANDOFF_SETTLE_MS));
}

export function createLaunchController(dependencies: LaunchControllerDependencies): LaunchController {
  const settleHandoff = dependencies.settleHandoff ?? settleEntryHandoff;
  return {
    async start() {
      const window = await dependencies.createWindow();
      const context: EntryContext = {
        dev: dependencies.dev ?? false,
        lang: dependencies.lang ?? "en",
        desktopVersion: dependencies.desktopVersion,
        consoleVersion: dependencies.consoleVersion ?? (() => null),
      };
      const push = async (state: RuntimeEntryState, detail?: string, progress?: number): Promise<void> => {
        if (window.isDestroyed?.()) return;
        await dependencies.pushEntry(window.webContents, snapshotFor(context, state, detail, progress));
      };
      await push(context.dev ? "dev" : "checking");
      dependencies.onWindowReady?.(push);
      window.show();
      let consoleUrl: string;
      while (true) {
        try {
          consoleUrl = await dependencies.startOrAdopt();
          break;
        } catch (error) {
          if (!isFirstRunProcurementFailure(error)) throw error;
          await push("firstfail");
          if (!dependencies.onFirstRunFailure || !await dependencies.onFirstRunFailure()) throw error;
        }
      }
      if (window.isDestroyed?.()) return window;
      const origin = new URL(consoleUrl).origin;
      dependencies.handoffOrigin(origin);
      await dependencies.synchronizeTheme?.(origin);
      await push("starting", "ready");
      if (!window.isDestroyed?.()) await settleHandoff(window.webContents);
      if (!window.isDestroyed?.()) {
        await window.loadURL(consoleUrl);
        if (!window.isDestroyed?.()) window.webContents.navigationHistory.clear();
      }
      if (!window.isDestroyed?.()) await dependencies.synchronizeFullscreen?.(origin);
      if (!window.isDestroyed?.()) dependencies.onConsoleLoaded?.();
      return window;
    },
  };
}

function isFirstRunProcurementFailure(error: unknown): error is Error {
  return error instanceof Error && error.message === "console_runtime_unavailable";
}

interface EntryContext {
  readonly dev: boolean;
  readonly lang: EntryLanguage;
  readonly desktopVersion?: string;
  readonly consoleVersion: () => string | null;
}

interface EntryLine {
  readonly tone: EntryTone;
  readonly title: string;
  readonly detail?: string;
  readonly progress?: number | "indeterminate";
  readonly handoff?: boolean;
}

const COPY = {
  ko: {
    tagline: "에이전트 작업을 한 화면에서",
    checking: "업데이트 확인 중",
    node: "실행 환경을 받는 중",
    nodeDetail: "Node.js",
    installing: (target: string) => `${target} 설치 중`,
    installingFallback: "Fleet Console 설치 중",
    offlineInstallFailed: "업데이트를 설치하지 못했습니다",
    offlineUnreachable: "업데이트를 확인하지 못했습니다",
    offlineDetail: "설치된 버전으로 시작합니다",
    firstfail: "Fleet Console을 설치하지 못했습니다",
    firstfailDetail: "연결을 확인한 뒤 다시 시도하세요",
    starting: "Console 시작 중",
    ready: "준비됐습니다",
    devDetail: "개발 빌드 · 업데이트 건너뜀",
  },
  en: {
    tagline: "Agent work, on one screen",
    checking: "Checking for updates",
    node: "Downloading the runtime",
    nodeDetail: "Node.js",
    installing: (target: string) => `Installing ${target}`,
    installingFallback: "Installing Fleet Console",
    offlineInstallFailed: "Couldn't install the update",
    offlineUnreachable: "Couldn't check for updates",
    offlineDetail: "Starting with the installed version",
    firstfail: "Couldn't install Fleet Console",
    firstfailDetail: "Check your connection and try again",
    starting: "Starting Console",
    ready: "Ready",
    devDetail: "Development build · updates skipped",
  },
} as const;

function snapshotFor(context: EntryContext, state: RuntimeEntryState, detail?: string, progress?: number): EntryPageSnapshot {
  const copy = COPY[context.lang];
  const line = lineFor(copy, state, detail, progress);
  return {
    platform: process.platform,
    lang: context.lang,
    dev: context.dev,
    tagline: copy.tagline,
    versions: versionLine(context),
    ...line,
  };
}

function lineFor(copy: (typeof COPY)[EntryLanguage], state: RuntimeEntryState, detail?: string, progress?: number): EntryLine {
  // 조달 경로는 진행률을 0으로만 알린다 — 0은 "얼마나 남았는지 모른다"로 읽고 흐르는 막대를 쓴다.
  const bar = typeof progress === "number" && progress > 0 ? progress : "indeterminate";
  switch (state) {
    case "dev": return { tone: "busy", title: copy.starting, detail: copy.devDetail };
    case "node": return { tone: "busy", title: copy.node, detail: copy.nodeDetail, progress: bar };
    case "installing": return { tone: "busy", title: detail ? copy.installing(detail) : copy.installingFallback, progress: bar };
    case "offline": return { tone: "warning", title: detail === "install-failed" ? copy.offlineInstallFailed : copy.offlineUnreachable, detail: copy.offlineDetail };
    case "firstfail": return { tone: "failed", title: copy.firstfail, detail: copy.firstfailDetail };
    case "starting": return detail === "ready" ? { tone: "done", title: copy.ready, handoff: true } : { tone: "busy", title: copy.starting };
    default: return { tone: "busy", title: copy.checking };
  }
}

function versionLine(context: EntryContext): string {
  const parts: string[] = [];
  if (context.desktopVersion) parts.push(`Desktop ${context.desktopVersion}`);
  const consoleVersion = context.dev ? null : context.consoleVersion();
  if (consoleVersion) parts.push(`Console ${consoleVersion}`);
  return parts.join(" · ");
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { Link } from "react-router-dom";

import { fetchConsoleEnvironment } from "../../integration/api.js";
import { commandBandCenterFits, commandBandCenterGutter } from "./command-band-guards.js";
import { ViewModeToggle } from "./view-mode-toggle.js";
import { useConsoleState } from "../../hooks/use-store.js";
import { useUpdateProgress } from "../../../../../features/updates/client/update-progress-store.js";
import type { ConsoleEnvironmentDiagnostics } from "../../integration/types.js";
import { useT } from "../../i18n/index.js";
import { useViewMode } from "../../integration/view-mode-store.js";
import { isDesktopShell } from "../../integration/desktop-shell.js";
import { useDesktopFullscreenSnapshot } from "../../integration/desktop-fullscreen.js";
import { setBandToolbarHost } from "../../integration/toolbar-slots.js";
import { useZenMode } from "../../integration/zen-mode.js";

interface CommandBandProps {
  readonly operationsViewVisible: boolean;
}

export function CommandBand({ operationsViewVisible: requestedOperationsViewVisible }: CommandBandProps) {
  const t = useT();
  const zenMode = useZenMode();
  const state = useConsoleState();
  const updateProgress = useUpdateProgress();
  const viewMode = useViewMode();
  const operationsViewVisible = requestedOperationsViewVisible && viewMode.effective !== "mobile";
  const environmentTriggerRef = useRef<HTMLButtonElement>(null);
  const environmentPopoverRef = useRef<HTMLDivElement>(null);
  const commandBandRef = useRef<HTMLElement>(null);
  const toolbarHostRef = useRef<HTMLSpanElement | null>(null);
  // 도구모음 자리는 둘이 함께 쥔다 — 도구모음이 옮겨 들어올 자리(toolbar-slots)와 가운데 폭을 재는 이 밴드.
  const setToolbarHost = useCallback((element: HTMLSpanElement | null) => {
    toolbarHostRef.current = element;
    setBandToolbarHost(element);
  }, []);
  const bandLeftRef = useRef<HTMLDivElement>(null);
  const bandRightRef = useRef<HTMLDivElement>(null);
  const [bandWidth, setBandWidth] = useState(0);
  const [leftContentEnd, setLeftContentEnd] = useState(0);
  const [rightContentWidth, setRightContentWidth] = useState(0);
  const [centerContentWidth, setCenterContentWidth] = useState(0);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<ConsoleEnvironmentDiagnostics | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailedValue, setCopyFailedValue] = useState<string | null>(null);
  // 도구모음은 중앙 트랙의 단독 승객이다. 중앙은 Console 전체 정중앙에 고정하므로 여백 하한은
  // 좌·우 클러스터의 실측 콘텐츠 폭 중 큰 쪽에서 잰다 — 한쪽만 예약하면 중앙이 viewport 중앙에서
  // 밀리거나 우측과 겹친다.
  const centerGutter = commandBandCenterGutter(leftContentEnd, rightContentWidth);
  // 중앙이 하한 사이에 들어가지 못하는 폭에서는 감추는 대신 좌측 플로우로 되돌린다 — 도구모음의
  // 모드 스위치는 캔버스 모드의 유일한 조작면이라 접을 수 없다. 판정용 centerGutter는 그대로 두어
  // 되돌아오는 폭이 흔들리지 않게 하고, CSS에 주입하는 값만 0으로 내린다.
  const centerControlsCentered = commandBandCenterFits(bandWidth, centerGutter, centerContentWidth);
  const injectedCenterGutter = centerControlsCentered ? centerGutter : 0;
  // 열림/닫힘 전환 시 이벤트 핸들러에서 동기 호출한다 — open effect(폐기 후 fetch)는 paint 뒤에 돌므로
  // 여기서 지우지 않으면 재오픈 첫 프레임에 이전 절대경로가 그대로 렌더된다.
  const discardEnvironmentState = () => {
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(false);
    setCopiedValue(null);
    setCopyFailedValue(null);
  };
  const desktopShell = typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
  // 전체화면에서 밴드는 창 모드와 똑같은 흐름 요소다 — 자동 은닉·엣지 스트립·도킹 핀은
  // 퇴역했다. 크롬을 치우는 결정은 Zen 하나가 소유한다(중복 제스처 정리).
  // 이 스냅숏이 남은 이유는 단 하나: darwin 전체화면에서 신호등이 물러난 자리로 좌측
  // 클러스터를 활주시키기 위해서다. 브라우저 전체화면에는 신호등이 없으므로 대상이 아니다.
  const nativeFullscreen = useDesktopFullscreenSnapshot();
  useEffect(() => {
    if (!zenMode) return;
    setEnvironmentOpen(false);
    discardEnvironmentState();
  }, [zenMode]);

  useEffect(() => {
    if (!environmentOpen) return;
    const controller = new AbortController();
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(true);
    fetchConsoleEnvironment(controller.signal)
      .then((result) => { if (!controller.signal.aborted) setEnvironment(result); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEnvironmentError(error instanceof Error ? error.message : t("chrome.commandBand.unableToLoadEnvironment"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setEnvironmentLoading(false);
      });
    return () => controller.abort();
  }, [environmentOpen, t]);

  useEffect(() => {
    if (!environmentOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || environmentTriggerRef.current?.contains(target) || environmentPopoverRef.current?.contains(target)) return;
      setEnvironmentOpen(false);
      discardEnvironmentState();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setEnvironmentOpen(false);
      discardEnvironmentState();
      environmentTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [environmentOpen]);

  // 좌·우 클러스터의 실측 콘텐츠 폭이 중앙 여백 하한의 원료이고, 도구모음의 자연 폭이 중앙
  // 소요 폭이다. 사이드바 폭이 아니라 클러스터 폭이 하한을 정하므로 viewport 미디어쿼리로는
  // 판정할 수 없다. 자식 끝을 재는 이유: 칩 폭 변화(연결 상태 라벨·폰트 로드)와 도구모음의
  // 접기·플러그인 항목 변동이 모두 하한·소요 폭을 움직인다. offsetParent 좌표계는 밴드와 동일하다.
  useLayoutEffect(() => {
    const band = commandBandRef.current;
    if (!band || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = band.clientWidth;
      setBandWidth(width);
      const bandLeft = bandLeftRef.current;
      setLeftContentEnd(bandLeft === null ? 0 : Math.max(0, ...Array.from(bandLeft.children, (child) => (child instanceof HTMLElement ? child.offsetLeft + child.offsetWidth : 0))));
      const bandRight = bandRightRef.current;
      setRightContentWidth(bandRight === null ? 0 : Math.max(0, ...Array.from(bandRight.children, (child) => (child instanceof HTMLElement ? width - child.offsetLeft : 0))));
      // scrollWidth를 읽는다 — 중앙 트랙이 소요 폭보다 좁게 눌린 프레임에서도 자연 폭을
      // 돌려주므로, 눌린 값이 판정에 되먹임되어 접힘/복귀가 진동하는 일이 없다.
      const toolbarHost = toolbarHostRef.current;
      setCenterContentWidth(toolbarHost === null ? 0 : toolbarHost.scrollWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    const toolbarHost = toolbarHostRef.current;
    if (toolbarHost) observer.observe(toolbarHost);
    // 칩·트레이 폭 변화도 하한을 움직인다 — 자식을 직접 관찰하고, 자식의 등장/퇴장은
    // 아래 deps가 effect를 다시 돌려 관찰 대상을 갱신한다(모드 전환·fullscreen 핀 포함).
    const bandLeft = bandLeftRef.current;
    if (bandLeft) for (const child of bandLeft.children) observer.observe(child);
    const bandRight = bandRightRef.current;
    if (bandRight) for (const child of bandRight.children) observer.observe(child);
    // 도구모음은 deps 밖에서 옮겨 들어오고(Zen 종료) 그 안의 항목도 나타나고 사라진다(부관을 두면
    // null → 글리프). 자식 목록의 변화를 직접 보고 다시 재며, 새 자식도 관찰 대상에 넣는다.
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof HTMLElement) observer.observe(node);
      }
      measure();
    });
    if (mutations && bandRight) mutations.observe(bandRight, { childList: true, subtree: true });
    if (mutations && bandLeft) mutations.observe(bandLeft, { childList: true, subtree: true });
    if (mutations && toolbarHost) mutations.observe(toolbarHost, { childList: true, subtree: true });
    // darwin 전체화면의 좌측 인셋 활주(88px ↔ 8px)는 자식을 옮기기만 하고 크기는 바꾸지 않아
    // ResizeObserver가 울지 않는다. 하한은 자식의 offsetLeft에서 나오므로 전이가 끝난 뒤 한 번
    // 더 잰다 — 축소 모션 선호에서는 전이가 없어 이벤트도 없지만, 그때는 첫 measure()가 이미
    // 최종 값을 읽는다.
    const remeasureAfterGlide = (event: TransitionEvent) => {
      if (event.propertyName === "padding-inline-start") measure();
    };
    bandLeft?.addEventListener("transitionend", remeasureAfterGlide);
    return () => {
      observer.disconnect();
      mutations?.disconnect();
      bandLeft?.removeEventListener("transitionend", remeasureAfterGlide);
    };
  }, [operationsViewVisible, state.channel, state.connection, nativeFullscreen]);

  useEffect(() => {
    if (state.channel === "local") return;
    setEnvironmentOpen(false);
    setEnvironment(null);
    setEnvironmentError(null);
    setEnvironmentLoading(false);
    setCopiedValue(null);
    setCopyFailedValue(null);
  }, [state.channel]);

  const copyEnvironmentValue = (value: string) => {
    // 복사 실패는 해당 버튼의 인라인 상태로만 알린다 — environmentError는 fetch 실패 전용이며
    // 세팅하면 팝오버 전체가 에러 화면으로 대체되어 진단 값 자체를 볼 수 없게 된다.
    void navigator.clipboard.writeText(value)
      .then(() => { setCopiedValue(value); setCopyFailedValue(null); })
      .catch(() => { setCopyFailedValue(value); setCopiedValue(null); });
  };

  // Zen만이 밴드를 내린다. 밴드는 마운트된 채 inert로 물러나므로, 그 안에 자리를 빌린
  // 도구모음(과 그 안의 플러그인 항목)은 Zen 트레이로 옮겨 간다(console-toolbar.tsx).
  const commandBandHidden = zenMode;

  return (
    <>
      <header
        ref={commandBandRef}
        className={`command-band${requestedOperationsViewVisible ? " is-operations" : " is-utility"}${centerControlsCentered ? "" : " is-center-flow"}${nativeFullscreen ? " is-native-fullscreen" : ""}`}
        style={{
          "--command-band-center-gutter": `${injectedCenterGutter}px`,
        } as CSSProperties}
        aria-hidden={commandBandHidden || undefined}
        inert={commandBandHidden || undefined}
      >
      <div ref={bandLeftRef} className="command-band-left">
        {state.channel === "local" ? (
          <div className="command-band-brand is-local command-band-environment">
            <button
              ref={environmentTriggerRef}
              type="button"
              className="command-band-brand-diagnostics"
              aria-label={`${t("chrome.commandBand.environment")}: ${t(desktopShell ? "chrome.commandBand.localDesktop" : "chrome.commandBand.local")}`}
              aria-haspopup="dialog"
              aria-expanded={environmentOpen}
              onKeyDown={(event) => {
                // 캔버스의 Space-pan이 버튼의 기본 활성화를 취소하지 않게 한다. 클릭은 브라우저가 만든다.
                if (event.code === "Space") event.stopPropagation();
              }}
              onClick={() => { discardEnvironmentState(); setEnvironmentOpen((open) => !open); }}
            >
              <BrandMarkIcon local />
            </button>
            <Link
              className="command-band-brand-home"
              to="/operations"
              aria-label={t("chrome.commandBand.operations")}
              onClick={() => { setEnvironmentOpen(false); discardEnvironmentState(); }}
            >
              <BrandWordmark local />
            </Link>
            {environmentOpen ? <div ref={environmentPopoverRef}><EnvironmentPopover environment={environment} error={environmentError} loading={environmentLoading} copiedValue={copiedValue} copyFailedValue={copyFailedValue} desktopShell={desktopShell} onCopy={copyEnvironmentValue} /></div> : null}
          </div>
        ) : <BrandHome />}
        {/* 업데이트 중에는 링크 상실이 고장이 아니라 진행이다. 커튼이 그 사실을 말하고 있는
            동안 이 칩까지 "연결 끊김"이라고 말하면, 한 화면이 두 가지 이야기를 한다. */}
        {state.connection !== "live" && !updateProgress.watching ? (
          <span className="command-band-link-chip" data-link-state={state.connection}>
            {t(state.connection === "offline" ? "chrome.link.offline" : "chrome.link.reconnecting")}
          </span>
        ) : null}
      </div>
      {/* 도구모음의 자리 — 상단 바 가운데. 모드 스위치·도구·찾기·원격·도움말·플러그인 항목(부관)·Zen 켜기가
          한 줄로 선다(console-toolbar.tsx). Zen에서는 같은 줄이 작업 표시줄 트레이로 옮겨 간다. */}
      <div className="command-band-center">
        <span ref={setToolbarHost} className="command-band-toolbar" />
      </div>
      <div ref={bandRightRef} className="command-band-right">
        {!isDesktopShell() ? <ViewModeToggle className="command-band-button command-band-viewmode" /> : null}
      </div>
      </header>
    </>
  );
}

interface EnvironmentPopoverProps {
  readonly environment: ConsoleEnvironmentDiagnostics | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly copiedValue: string | null;
  readonly copyFailedValue: string | null;
  readonly desktopShell: boolean;
  readonly onCopy: (value: string) => void;
}

function EnvironmentPopover({ environment, error, loading, copiedValue, copyFailedValue, desktopShell, onCopy }: EnvironmentPopoverProps) {
  const t = useT();
  if (loading) return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>{t("chrome.commandBand.loadingEnvironment")}</div>;
  if (error) return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>{error}</div>;
  if (!environment) return null;
  const rows = buildEnvironmentRows(t, environment, desktopShell);
  return <div className="command-band-environment-popover" role="dialog" aria-label={t("chrome.commandBand.environment")}>
    <div className="command-band-environment-title">{t("chrome.commandBand.environment")}</div>
    {rows.map(([label, value]) => <div key={label} className="command-band-environment-row"><span>{label}</span><code>{value}</code><button type="button" onClick={() => onCopy(value)}>{copiedValue === value ? t("chrome.commandBand.env.copied") : copyFailedValue === value ? t("chrome.commandBand.env.copyFailed") : t("chrome.commandBand.env.copy")}</button></div>)}
    <div className="command-band-environment-footer">{t("chrome.commandBand.env.footer")}</div>
  </div>;
}

function buildEnvironmentRows(
  t: ReturnType<typeof useT>,
  environment: ConsoleEnvironmentDiagnostics,
  desktopShell: boolean,
): readonly [string, string][] {
  return [
    [t("chrome.commandBand.env.channel"), environment.channel],
    [t("chrome.commandBand.env.version"), environment.version],
    [t("chrome.commandBand.env.reachableOn"), `127.0.0.1:${environment.effectivePort}`],
    [t("chrome.commandBand.env.dataRoot"), environment.dataDir],
    [t("chrome.commandBand.env.runtimeLock"), environment.lockFile],
    ...(desktopShell ? [[t("chrome.commandBand.env.desktopData"), `${environment.dataDir}/desktop`] as [string, string]] : []),
  ];
}

function BrandHome() {
  const t = useT();
  return <Link className="command-band-brand" to="/operations" aria-label={t("chrome.commandBand.operations")}><BrandMarkIcon /><span className="command-band-brand-wordmark">Fleet</span></Link>;
}

/**
 * 브랜드 워드마크 — Band·Zen 트레이·Zen 전환 장면이 같은 글자를 쓴다(서체는 이 클래스 하나가 진다).
 * 개발 채널은 승인된 개발 잉크에 황동 가운데 점과 작은 모노 대문자 DEV를 잇는다 — 「Fleet·DEV」.
 * 점과 DEV는 em으로 서므로 워드마크의 크기(트레이 13px, 전환 장면 40px)를 그대로 따라간다.
 */
export function BrandWordmark({ className, local = false, ref }: { readonly className?: string; readonly local?: boolean; readonly ref?: Ref<HTMLSpanElement> }) {
  return (
    <span ref={ref} className={`command-band-brand-wordmark${className ? ` ${className}` : ""}${local ? " is-local" : ""}`}>
      Fleet
      {local ? (
        <>
          <span className="command-band-brand-wordmark-sep" aria-hidden="true">·</span>
          <span className="command-band-brand-wordmark-tag">DEV</span>
        </>
      ) : null}
    </span>
  );
}

// 일반 채널은 favicon과 같은 조형이다. 개발 채널만 바깥 링을 열고 신호점을 빼 구분한다.
// Zen 작업 표시줄의 앰블럼과 전환 장면의 날아가는 마크도 이 조형 하나를 쓴다.
export function BrandMarkIcon({ className = "command-band-brand-glyph", local = false }: { readonly className?: string; readonly local?: boolean } = {}) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--ink-deep)" stroke="var(--surface-rim-strong)" strokeWidth="2" />
      {local
        ? <path d="M48.33 23.31A18.5 18.5 0 0 1 48.33 40.69M40.69 48.33A18.5 18.5 0 0 1 23.31 48.33M15.67 40.69A18.5 18.5 0 0 1 15.67 23.31M23.31 15.67A18.5 18.5 0 0 1 40.69 15.67" fill="none" stroke="var(--brass)" strokeWidth="3.5" strokeLinecap="round" />
        : <circle cx="32" cy="32" r="18.5" fill="none" stroke="var(--brass)" strokeWidth="3.5" />}
      <circle cx="32" cy="32" r="10.5" fill="none" stroke="var(--brass)" strokeWidth="1.8" opacity="0.55" />
      <path d="M32 9v8M32 47v8M9 32h8M47 32h8" stroke="var(--brass)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="32" r="3" fill="var(--brass)" />
      {local ? null : <circle cx="44.7" cy="19.3" r="5" fill="var(--aurora)" />}
    </svg>
  );
}

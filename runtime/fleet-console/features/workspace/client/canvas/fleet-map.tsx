import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { operationMarkVisual, resolveOperationActivity, resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { getIdleArrivalIds } from "../../../execution/client/operation-marks.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import type { OperationGeometry, OperationNode } from "../../../../core/client/src/integration/types.js";
import { resolveFleetMapDriftStyle, resolveFleetMapMarkerLayout, resolveFleetMapZoneLayout } from "./fleet-map-layout.js";
import { FleetMapDetailCard, type FleetMapDetailStatus } from "./fleet-map-detail-card.js";

/** 포인터가 점을 스쳐 지나가는 것과 겨누는 것을 가르는 시간 — 사이드바 상세 카드와 같은 값이다. */
const DETAIL_HOVER_DELAY_MS = 400;

interface OpenDetail {
  readonly operationId: string;
  /** 누가 열었나 — 키보드로 연 카드는 포인터가 그 점을 스치고 떠나도 거두지 않는다(초점이 아직 그 점에 있다). */
  readonly via: "pointer" | "keyboard";
  readonly anchor: DOMRect;
  readonly bounds: DOMRect;
  readonly obstacles: readonly DOMRect[];
}

export interface FleetMapTheater {
  readonly id: string;
  readonly label: string;
}

interface FleetMapProps {
  /** 전 Theater — 지도는 활성 Theater만이 아니라 함대 전체를 한 판에 얹는다. */
  readonly theaters: readonly FleetMapTheater[];
  /** 최소화되지 않은 전 Theater의 Operation. 휴면도 싣는다 — Cruise는 휴면 패널을 그리는 모드다. */
  readonly operations: readonly OperationNode[];
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  /** 런타임 맵을 믿을 수 있는가 — 준비되지 않았거나 끊겼으면 겨눈 카드는 상태를 "확인 불가"로 말한다. */
  readonly operationRuntimeHydration: OperationRuntimeHydration;
  readonly activeTheaterId: string | null;
  /** 판의 가로/세로 비 — 구역 원 배치가 픽셀 겹침을 피하는 데 쓴다. */
  readonly aspect: number;
  /** 줌이 이탈 임계를 넘은 뒤 퇴장 연출 동안만 true — 판은 사라지는 중이고 입력을 받지 않는다. */
  readonly leaving: boolean;
  /** 마커용 유효 geometry — durable DTO보다 라이브 캔버스 배치가 정본이다(자동 배치 op는 DTO가 null).
      canvas가 자기 스토어로 해석해 넘긴다. */
  readonly geometryFor: (operation: OperationNode) => OperationGeometry | null;
  /** 점을 고르면 그 Operation으로 내려간다 — 포커스 경로가 Theater 전환과 줌 복귀를 함께 진다. */
  readonly onPick: (operationId: string) => void;
  /** 구역 표석을 고르면 그 Theater를 올린다(활성 Theater 전환). */
  readonly onSelectTheater?: (theaterId: string) => void;
  readonly onOperationContextMenu?: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
  readonly onTheaterContextMenu?: (theaterId: string, anchor: { readonly x: number; readonly y: number }) => void;
}

// Theater 구역의 식별 톤 — theaters 선언 순서(theaterIndex)로 배정해 함대 구성이 변해도 같은
// Theater가 같은 색을 유지한다. 구역은 정체성이므로 --id-* 채널이 맞고, 점(상태)은 신호 토큰이다.
const FLEET_ZONE_TONES: readonly string[] = ["teal", "amber", "plum", "moss", "cerulean", "rose", "crimson", "indigo"];

/** 함대 지도 — Cruise 캔버스가 판독 한계 아래로 축소되면 패널 자리에 서는 판. 지구본 위 작전구역처럼
 *  각 Theater가 원형 구역으로 떠 있고 그 안에 소속 Operation이 점으로 모인다. 판은 캔버스 위의 층이라
 *  바다에서의 휠·팬은 그대로 캔버스로 흐른다 — 확대하면 판이 걷히고 패널이 돌아온다. */
export function FleetMap({
  theaters,
  operations,
  operationRuntime,
  operationRuntimeHydration,
  activeTheaterId,
  aspect,
  leaving,
  geometryFor,
  onPick,
  onSelectTheater,
  onOperationContextMenu,
  onTheaterContextMenu,
}: FleetMapProps) {
  const t = useT();
  const idleArrivalIds = getIdleArrivalIds();
  const bands = theaters
    .map((theater, theaterIndex) => ({
      theater,
      theaterIndex,
      operations: operations.filter((operation) => operation.theaterId === theater.id),
    }))
    .filter((band) => band.operations.length > 0);
  // 마커 배치는 구역이 몇 개로 갈리는지 안 뒤에 정한다 — 중앙 표석은 구역이 둘 이상일 때만
  // 서므로, 그때만 마커가 비켜설 띠를 잡는다(단일 함대는 판 전체가 열린 바다다).
  const markersByTheater = new Map(bands.map((band) => [
    band.theater.id,
    resolveFleetMapMarkerLayout(
      band.operations.map((operation) => ({ id: operation.id, geometry: geometryFor(operation) })),
      bands.length > 1,
    ),
  ]));
  // 평면은 제품의 등록 Theater 자체가 하나일 때만이다. 다중 Theater 환경에서 최소화로 외부
  // Theater 하나만 남은 것은 단일 함대가 아니다 — 표석을 없애면 소속과 Theater 마운트 문이 함께
  // 사라진다. 그 경우 구역 하나를 유지한다.
  const plane = theaters.length === 1 && bands.length === 1;
  const zones = plane
    ? []
    : resolveFleetMapZoneLayout(
        bands.map((band) => ({ theaterId: band.theater.id, count: band.operations.length, slotIndex: band.theaterIndex })),
        aspect,
      );

  // ── 겨눈 점의 상세 카드 ──────────────────────────────────────────────────
  // 포인터는 잠깐 머문 뒤에, 키보드 포커스는 곧바로 연다. 터치는 열지 않는다 — 첫 탭은 오늘처럼 이동이다.
  // 카드는 읽기만 한다: 여닫는 동안 활성 Operation·Theater·줌·미확인 표시는 그대로다.
  const mapRef = useRef<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<OpenDetail | null>(null);
  const detailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Escape·누름·메뉴로 닫은 점 — 그 점에 새로 들어오거나 새로 포커스하기 전에는 저절로 다시 열지 않는다.
  const suppressedDetailRef = useRef<string | null>(null);
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const detailId = useId();
  const cancelDetailTimer = () => {
    if (detailTimerRef.current) {
      clearTimeout(detailTimerRef.current);
      detailTimerRef.current = null;
    }
  };
  const closeDetail = () => {
    cancelDetailTimer();
    setDetail(null);
  };
  const openDetail = (operationId: string, element: HTMLElement, via: OpenDetail["via"]) => {
    const map = mapRef.current;
    if (!map || leavingRef.current || !element.isConnected) return;
    // 이웃 점은 열 때 한 번 잰다. 점은 유영하지만 진폭이 작고, 겨눈 점은 멈춰 있다.
    const obstacles = Array.from(map.querySelectorAll<HTMLElement>("[data-fleet-map-dot]"))
      .filter((dot) => dot !== element)
      .map((dot) => dot.getBoundingClientRect());
    setDetail({ operationId, via, anchor: element.getBoundingClientRect(), bounds: map.getBoundingClientRect(), obstacles });
  };
  const releaseSuppressionFor = (operationId: string) => {
    if (suppressedDetailRef.current !== null && suppressedDetailRef.current !== operationId) suppressedDetailRef.current = null;
  };
  const suppressDetail = (operationId: string) => {
    suppressedDetailRef.current = operationId;
    closeDetail();
  };
  const armDetail = (operationId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== "mouse" || leaving) return;
    releaseSuppressionFor(operationId);
    if (detail && detail.operationId !== operationId) setDetail(null);
    cancelDetailTimer();
    // 이미 이 점의 카드가 떠 있으면(키보드로 연 경우) 다시 걸지 않는다 — 덮어쓰면 카드의 주인이 포인터로 바뀐다.
    if (suppressedDetailRef.current === operationId || detail?.operationId === operationId) return;
    const element = event.currentTarget;
    detailTimerRef.current = setTimeout(() => {
      detailTimerRef.current = null;
      openDetail(operationId, element, "pointer");
    }, DETAIL_HOVER_DELAY_MS);
  };
  const disarmDetail = (operationId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (suppressedDetailRef.current === operationId) suppressedDetailRef.current = null;
    cancelDetailTimer();
    // 키보드로 연 카드는 초점이 그 점에 남아 있는 한 포인터가 떠나도 남는다 — 읽던 사람은 아직 그 점에 있다.
    if (detail?.operationId !== operationId) return;
    if (detail.via === "keyboard" && document.activeElement === event.currentTarget) return;
    setDetail(null);
  };
  const focusDetail = (operationId: string, event: ReactFocusEvent<HTMLButtonElement>) => {
    releaseSuppressionFor(operationId);
    if (suppressedDetailRef.current === operationId || leaving) return;
    if (!matchesFocusVisible(event.currentTarget)) return;
    cancelDetailTimer();
    openDetail(operationId, event.currentTarget, "keyboard");
  };
  const blurDetail = (operationId: string, event: ReactFocusEvent<HTMLButtonElement>) => {
    // 메뉴로 초점이 건너간 것은 떠난 것이 아니다 — 메뉴가 닫히며 초점을 돌려줄 때 카드가 다시 뜨면 안 된다.
    const toMenu = event.relatedTarget instanceof Element && event.relatedTarget.closest('[role="menu"]') !== null;
    if (suppressedDetailRef.current === operationId && !toMenu) suppressedDetailRef.current = null;
    if (detail?.operationId === operationId) closeDetail();
  };

  // 열린 카드는 열 때 잰 자리를 들고 있다 — 지도가 걷히거나 점이 사라지거나 화면에서 옮겨지면 그 자리는
  // 거짓이다. 구역 안 좌표가 아니라 그려진 자리를 본다: 다른 Theater의 수가 바뀌면 구역 자체가 커지거나
  // 옮겨져, 구역 안 좌표는 그대로여도 점은 화면에서 움직인다. 겨눈 점은 유영을 멈추므로 자리가 흔들리지 않는다.
  useLayoutEffect(() => {
    if (!detail) return;
    const map = mapRef.current;
    const dot = map?.querySelector<HTMLElement>(`[data-fleet-map-dot="${CSS.escape(detail.operationId)}"]`);
    if (leaving || !map || !dot) {
      closeDetail();
      return;
    }
    if (movedRect(dot.getBoundingClientRect(), detail.anchor) || movedRect(map.getBoundingClientRect(), detail.bounds)) closeDetail();
  });
  useEffect(() => {
    closeDetail();
  }, [activeTheaterId, aspect]);
  useEffect(() => {
    if (!detail) return;
    const openId = detail.operationId;
    const dismiss = () => closeDetail();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") suppressDetail(openId);
    };
    // 빈 바다의 휠·누름은 캔버스 조작(줌·팬)이다 — 카드는 함께 물러난다. 점 위 휠은 캔버스 대상이 아니다.
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-fleet-map-dot]")) return;
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [detail]);
  useEffect(() => () => cancelDetailTimer(), []);

  const detailOperation = detail ? operations.find((operation) => operation.id === detail.operationId) ?? null : null;
  const detailStatus = (operation: OperationNode): FleetMapDetailStatus => {
    // 점은 모름을 표시 어휘(유휴)로 접어 그리지만, 카드는 모름을 모름이라고 말한다.
    if (operationRuntimeHydration !== "ready") return "unknown";
    const activity = resolveOperationActivity(operation, operationRuntime);
    if (!operationRuntime[operation.id] && activity === "idle") return "unknown";
    return operationMarkVisual(resolveOperationMarkVisual({ activity, operationId: operation.id, idleArrivalIds }));
  };

  const openOperationMenu = (operationId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    suppressDetail(operationId);
    onOperationContextMenu?.(operationId, new DOMRect(event.clientX, event.clientY, 0, 0), event.currentTarget);
  };
  const openOperationMenuFromKeyboard = (operationId: string, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      if (detail?.operationId !== operationId) return;
      event.preventDefault();
      suppressDetail(operationId);
      return;
    }
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    suppressDetail(operationId);
    onOperationContextMenu?.(operationId, event.currentTarget.getBoundingClientRect(), event.currentTarget);
  };
  // 구역의 빈 자리 우클릭은 그 Theater의 실행 메뉴다 — 점은 자기 메뉴를 열고 여기 닿지 않는다.
  const openTheaterMenu = (theaterId: string, event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.target instanceof Element && event.target.closest("[data-fleet-map-dot]")) return;
    // 표석 위의 우클릭도 그 Theater의 메뉴다 — 표석은 구역의 일부다.
    event.preventDefault();
    event.stopPropagation();
    onTheaterContextMenu?.(theaterId, { x: event.clientX, y: event.clientY });
  };

  const renderDots = (band: (typeof bands)[number]) => markersByTheater.get(band.theater.id)?.map((marker) => {
    const operation = band.operations.find((candidate) => candidate.id === marker.operationId);
    if (!operation) return null;
    // 점·사이드바 칩·커맨드 밴드가 같은 마크 축을 써서 도착을 "unseen"(초록 느린 점등)으로 읽는다.
    const visual = operationMarkVisual(resolveOperationMarkVisual({
      activity: resolveOperationActivity(operation, operationRuntime),
      operationId: operation.id,
      idleArrivalIds,
    }));
    return (
      <button
        key={marker.operationId}
        type="button"
        className={`canvas-fleet-map-dot is-${visual}`}
        data-fleet-map-dot={marker.operationId}
        // 점은 캔버스 제스처의 대상이 아니다 — 여기서 시작한 포인터는 팬·생성으로 흐르지 않는다.
        data-canvas-blocker
        // 모든 점이 제자리에서 유영한다 — 살아 있는 함대의 판에서 정지한 점은 죽은 표시로 읽힌다.
        style={{ left: `${marker.x}%`, top: `${marker.y}%`, ...resolveFleetMapDriftStyle(operation.id, visual === "running") }}
        aria-label={t("canvas.fleetMap.dotAria", { title: operation.title })}
        aria-haspopup="menu"
        aria-describedby={detail?.operationId === operation.id ? detailId : undefined}
        tabIndex={leaving ? -1 : 0}
        onPointerEnter={(event) => armDetail(operation.id, event)}
        onPointerLeave={(event) => disarmDetail(operation.id, event)}
        onPointerDown={() => suppressDetail(operation.id)}
        onFocus={(event) => focusDetail(operation.id, event)}
        onBlur={(event) => blurDetail(operation.id, event)}
        onContextMenu={(event) => openOperationMenu(operation.id, event)}
        onKeyDown={(event) => openOperationMenuFromKeyboard(operation.id, event)}
        onClick={() => {
          closeDetail();
          onPick(operation.id);
        }}
      >
        <span className="canvas-fleet-map-dot-label">{operation.title}</span>
      </button>
    );
  });

  return (
    <div
      ref={mapRef}
      className={`canvas-fleet-map ${leaving ? "is-leaving" : ""}`}
      data-fleet-map
      aria-hidden={leaving || undefined}
      role="group"
      aria-label={t("canvas.fleetMap.caption", { operations: operations.length, theaters: bands.length })}
    >
      <div className="canvas-fleet-map-caption">
        {t("canvas.fleetMap.caption", { operations: operations.length, theaters: bands.length })}
      </div>
      <div className="canvas-fleet-map-plate">
        {plane ? (
          // 등록 Theater 자체가 하나뿐이면 구역을 나눌 이유가 없다 — 원 없이 판 전체가 그 함대의 바다다.
          <div
            className="canvas-fleet-map-field is-plane"
            onContextMenu={(event) => openTheaterMenu(bands[0]!.theater.id, event)}
          >
            {renderDots(bands[0]!)}
          </div>
        ) : bands.map((band, bandIndex) => {
          const zone = zones[bandIndex]!;
          return (
            <section
              className={`canvas-fleet-map-zone ${band.theater.id === activeTheaterId ? "is-active" : ""}`}
              key={band.theater.id}
              data-fleet-map-zone={band.theater.id}
              onContextMenu={(event) => openTheaterMenu(band.theater.id, event)}
              style={{
                "--zone-x": `${zone.centerX}%`,
                "--zone-y": `${zone.centerY}%`,
                "--zone-size": `${zone.size}%`,
                "--zone-tint": `var(--id-${FLEET_ZONE_TONES[band.theaterIndex % FLEET_ZONE_TONES.length]})`,
              } as CSSProperties}
            >
              {/* 구역의 이름표는 원주 대신 구역 중앙에 선다 — 점선 원주를 걷어낸 판에서
                  "여기가 어느 Theater인가"를 말하는 것은 그 자리에 놓인 문구 자체다.
                  표석은 그 Theater로 가는 문이기도 하다 — 겨누면 brass로 밝아지고 누르면 그
                  Theater가 올라온다. 점처럼 캔버스 제스처에서 제외한다. */}
              <header className="canvas-fleet-map-zone-head">
                <button
                  type="button"
                  className="canvas-fleet-map-zone-pick"
                  data-fleet-map-zone-pick={band.theater.id}
                  data-canvas-blocker
                  aria-pressed={band.theater.id === activeTheaterId}
                  aria-label={t("canvas.fleetMap.zoneAria", { label: band.theater.label })}
                  tabIndex={leaving ? -1 : 0}
                  onClick={() => onSelectTheater?.(band.theater.id)}
                >
                  <span className="canvas-fleet-map-zone-title">
                    <span className="canvas-fleet-map-zone-chip" aria-hidden="true">{theaterInitials(band.theater.label)}</span>
                    <span className="canvas-fleet-map-zone-label">{band.theater.label}</span>
                  </span>
                  <span className="canvas-fleet-map-zone-counts">
                    {t("canvas.fleetMap.zoneCount", { count: band.operations.length })}
                  </span>
                </button>
              </header>
              <div className="canvas-fleet-map-field">
                {renderDots(band)}
              </div>
            </section>
          );
        })}
      </div>
      {detail && detailOperation && !leaving ? (
        <FleetMapDetailCard
          id={detailId}
          operation={detailOperation}
          status={detailStatus(detailOperation)}
          anchor={detail.anchor}
          bounds={detail.bounds}
          obstacles={detail.obstacles}
        />
      ) : null}
    </div>
  );
}

/** 반 픽셀 넘게 옮겨졌는가 — 같은 자리를 다시 잰 값의 부동소수 흔들림은 이동으로 치지 않는다. */
function movedRect(current: DOMRect, opened: DOMRect): boolean {
  return Math.abs(current.left - opened.left) > 0.5
    || Math.abs(current.top - opened.top) > 0.5
    || Math.abs(current.width - opened.width) > 0.5
    || Math.abs(current.height - opened.height) > 0.5;
}

/** 키보드로 온 포커스만 카드를 곧바로 연다 — 클릭·탭으로 생긴 포커스는 이동의 부산물이다. */
function matchesFocusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

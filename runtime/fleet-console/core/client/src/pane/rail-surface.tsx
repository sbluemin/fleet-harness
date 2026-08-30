import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ClientApiCapability, ClientExpandedSurfacesCapability } from "@fleet-console/sdk/plugin";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { OperationLaunchKind } from "@fleet-console/sdk/operations";
import type { PaneDescriptor, PaneOpenRequest } from "@fleet-console/sdk/pane";
import type { ConsoleTheme } from "@fleet-console/sdk/plugin";

import { createHostCapabilities } from "../plugin-capabilities.js";
import { isPaneExpanded, openExpandedPane } from "./expanded-pane-surface.js";
import { PaneBody, usePaneContext } from "./pane-body.js";
import { PaneCaption } from "./pane-caption.js";
import { PaneDivider } from "./pane-divider.js";
import { clampPrimaryWidth, MIN_PANE_PX, type PaneSplitLimits } from "./pane-geometry.js";
import { setPaneWidth, usePaneWidths } from "./pane-width-store.js";
import { usePaneIndex, type HostPaneContext, type RailEntryBinding } from "./pane-registry.js";
import { closePane, focusPane, openPane, replacePaneParams, resetSurfacePanes, useFocusedPaneId, useRailPanes } from "./pane-store.js";

/**
 * 레일 표면 — 활성 엔트리가 세우는 페인들을 담는 그릇.
 *
 * 표면이 소유하는 것: 열의 배치, 분할선, 캡션, 포커스. 페인이 소유하는 것: 캡션 아래 전부.
 * 이 경계가 계약의 실행부다.
 *
 * primary는 엔트리가 열리면 자동으로 선다. detail은 `panes.open`이 부를 때 선다 — 그래서
 * 등록은 독립이고 전이는 호출이라는 계약이 여기서 실제로 성립한다.
 */

// 능력 객체를 렌더마다 새로 만들면 컨텍스트가 매번 바뀌어 본문이 재마운트된다 —
// keepAlive가 지키려는 것을 정작 호스트가 깨뜨리는 자리다.
const HOST_CAPABILITIES = createHostCapabilities();

// 렌더마다 새 `{}`를 만들면 ctx의 useMemo가 매번 깨져 본문이 다시 그려진다.
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

export interface RailSurfaceProps {
  readonly binding: RailEntryBinding;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  readonly surfaces?: ClientExpandedSurfacesCapability;
  readonly onRequestExtraWidth?: (px: number | null) => void;
  readonly onLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
}

export const RailSurface = memo(function RailSurface({
  binding,
  theaterId,
  api,
  language,
  theme,
  surfaces,
  onRequestExtraWidth,
  onLaunchOperation,
}: RailSurfaceProps) {
  const openInstances = useRailPanes();
  const focusedPaneId = useFocusedPaneId();
  const paneWidths = usePaneWidths();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // 엔트리를 갈아타면 이전 표면의 열은 사라져야 한다. 비우지 않으면 돌아왔을 때 옛 detail이
  // 옛 params 그대로 되살아나고, keepAlive를 선언하지 않은 페인까지 스토어에 남는다.
  //
  // 남길 것은 **각 페인 자신의 서술자**가 정한다. 새로 선 엔트리의 목록으로 판단하면 떠나는
  // 엔트리가 지키던 터미널·초안이 그 자리에서 사라진다 — keepAlive가 약속한 바로 그것이.
  //
  // **엔트리가 실제로 바뀔 때만** 돈다. 서술자 색인은 판단의 근거일 뿐 계기가 아니다 —
  // 그 정체는 플러그인 레지스트리가 채워지며 부팅 중에 한두 번 바뀌고, 그것을 계기로 삼으면
  // 방금 복원한 열을 그 순간 치운다(실측: 새로고침 뒤 읽던 문서 열이 주차된 채로 남았다).
  //
  // 처음 서는 표면도 치울 것이 없다. 다른 엔트리가 두고 간 페인은 `owned`가 이미 걸러 낸다.
  const entryId = binding.entry.id;
  const paneIndexForReset = usePaneIndex();
  // 이 엔트리 소유의 페인 id — 정리에서 면제된다. 팔레트·딥링크는 표면을 열기 직전에
  // openPane으로 착지 params를 심는데, 그 씨앗이 이 마운트 정리에 쓸려 나가면 안 된다.
  const ownedIds = useMemo(() => new Set(binding.panes.map((pane) => pane.id)), [binding.panes]);
  const paneIndexRef = useRef(paneIndexForReset);
  paneIndexRef.current = paneIndexForReset;
  const ownedIdsRef = useRef(ownedIds);
  ownedIdsRef.current = ownedIds;
  const previousEntryRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousEntryRef.current;
    previousEntryRef.current = entryId;
    if (previous === null || previous === entryId) return;
    resetSurfacePanes(paneIndexRef.current, ownedIdsRef.current);
  }, [entryId]);

  const primary = useMemo(
    () => binding.panes.find((pane) => pane.role === "primary") ?? binding.panes[0],
    [binding.panes],
  );

  // 이 엔트리에 속한 페인만 세운다. 다른 엔트리의 페인이 열려 있어도 그것은 그 표면의 일이다.
  const owned = useMemo(() => new Map(binding.panes.map((pane) => [pane.id, pane])), [binding.panes]);
  const extras = useMemo(
    () => openInstances
      .filter((instance) => instance.paneId !== primary?.id && owned.has(instance.paneId))
      .map((instance) => ({ instance, descriptor: owned.get(instance.paneId)! })),
    [openInstances, owned, primary?.id],
  );
  // 주차된 페인은 `display: none`이라 자리를 차지하지 않는다 — 기하 계산에서도 빠져야 한다.
  const standing = useMemo(() => extras.filter(({ instance }) => instance.visible), [extras]);

  // 표면 폭 실측. 이 숫자는 **호스트 안에서만** 산다 — ctx로 흘리면 렌더마다 컨텍스트가
  // 새로 만들어져 본문이 다시 그려진다(계약이 `ctx.width`를 힌트로만 두는 이유).
  useLayoutEffect(() => {
    const node = surfaceRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = Math.round(node.getBoundingClientRect().width);
      setSurfaceWidth((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 갈라지기 직전의 폭. 첫 분할에서 primary를 이 값으로 세우면 사용자가 정해 둔 열 폭이
  // 그대로 남고 detail이 옆에 붙는다 — 기억된 폭이 없다고 기본값으로 되돌리면, 폭을 넓혀
  // 두었던 사용자는 문서를 열 때마다 트리가 좁아지는 것을 본다.
  const soloWidthRef = useRef(0);
  if (standing.length === 0 && surfaceWidth > 0) soloWidthRef.current = surfaceWidth;

  const limits: PaneSplitLimits = useMemo(() => ({
    surfaceWidth,
    minPrimary: primary?.minWidth ?? MIN_PANE_PX,
    minDetail: standing.reduce(
      (widest, { descriptor }) => Math.max(widest, descriptor.minWidth ?? MIN_PANE_PX),
      MIN_PANE_PX,
    ),
  }), [primary?.minWidth, standing, surfaceWidth]);

  // 순서가 곧 근거의 순서다: 사용자가 끈 폭 → 갈라지기 직전의 폭 → 서술자의 기본값.
  // 실측 전에는 soloWidth가 0이므로 `??`로 이으면 0이 기본값을 이겨 열이 최소폭으로 접힌다.
  const primaryWidth = clampPrimaryWidth(
    paneWidths[primary?.id ?? ""]
      ?? (soloWidthRef.current > 0 ? soloWidthRef.current : undefined)
      ?? primary?.defaultWidth
      ?? MIN_PANE_PX,
    limits,
  );

  // detail이 서면 표면 전체가 그만큼 넓어져야 한다 — 그러지 않으면 새 열은 primary를 잘라
  // 먹는다. 예전에 플러그인이 `requestExtraWidth`로 하던 일이며, 이제 표면이 자기가 세운
  // 열을 보고 스스로 요구한다.
  //
  // **서 있는 detail이 없을 때는 값을 건드리지 않는다.** 아직 한 본문 안에서 두 열을 그리는
  // 플러그인이 같은 창구로 폭을 요구하고 있어서, 0을 써 버리면 그 요구를 덮는다.
  const desiredExtra = standing.reduce(
    (sum, { descriptor }) => sum + (paneWidths[descriptor.id] ?? descriptor.defaultWidth ?? MIN_PANE_PX),
    0,
  );
  const ownsExtraRef = useRef(false);
  useEffect(() => {
    if (standing.length > 0) {
      ownsExtraRef.current = true;
      onRequestExtraWidth?.(desiredExtra);
      return;
    }
    if (!ownsExtraRef.current) return;
    ownsExtraRef.current = false;
    onRequestExtraWidth?.(null);
  }, [desiredExtra, onRequestExtraWidth, standing.length]);

  const handlePrimaryWidthChange = useCallback((width: number) => {
    if (!primary) return;
    setPaneWidth(primary.id, width);
  }, [primary]);

  if (!primary) return null;

  const primaryInstance = openInstances.find((instance) => instance.paneId === primary.id);
  const split = standing.length > 0;
  const primaryTitle = resolveLocalizedText(binding.entry.title, language);

  const primaryHost = (
    <PaneHost
      key={`${primary.id}:${theaterId ?? ""}`}
      descriptor={primary}
      instanceId={primaryInstance?.instanceId ?? `pane-primary-${primary.id}`}
      params={primaryInstance?.params ?? EMPTY_PARAMS}
      visible
      focused={focusedPaneId === primary.id}
      theaterId={theaterId}
      api={api}
      language={language}
      theme={theme}
      surfaces={surfaces}
      onRequestExtraWidth={onRequestExtraWidth}
      onLaunchOperation={onLaunchOperation}
      {...(split ? { width: primaryWidth } : {})}
    />
  );

  // detail은 primary **왼쪽**에 선다. 레일은 오른쪽 가장자리에 정박해 왼쪽으로 자라므로,
  // 목록 열이 아이콘 띠에 붙어 있어야 폭이 변해도 손이 가는 자리가 움직이지 않는다.
  // DOM 순서도 같게 두어 탭 이동이 눈에 보이는 순서를 따른다.
  return (
    <div
      ref={surfaceRef}
      className={`rail-surface${split ? " is-split" : ""}${isDragging ? " is-dragging" : ""}`}
      data-pane-count={standing.length + 1}
    >
      {extras.map(({ instance, descriptor }) => (
        <PaneHost
          key={`${instance.instanceId}:${theaterId ?? ""}`}
          descriptor={descriptor}
          instanceId={instance.instanceId}
          params={instance.params}
          visible={instance.visible}
          focused={focusedPaneId === descriptor.id}
          theaterId={theaterId}
          api={api}
          language={language}
          theme={theme}
          surfaces={surfaces}
          onRequestExtraWidth={onRequestExtraWidth}
          onLaunchOperation={onLaunchOperation}
        />
      ))}
      {split ? (
        <PaneDivider
          primaryPaneId={primary.id}
          primaryTitle={primaryTitle}
          width={primaryWidth}
          limits={limits}
          onWidthChange={handlePrimaryWidthChange}
          onDragStateChange={setIsDragging}
        />
      ) : null}
      {primaryHost}
    </div>
  );
});

interface PaneHostProps {
  readonly descriptor: PaneDescriptor;
  readonly instanceId: string;
  readonly params: Readonly<Record<string, string>>;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  readonly surfaces?: ClientExpandedSurfacesCapability;
  readonly onRequestExtraWidth?: (px: number | null) => void;
  readonly onLaunchOperation?: (pluginId: string, kind: OperationLaunchKind) => void;
  /** 표면이 정한 이 열의 폭(px). 생략하면 남는 자리를 채운다. */
  readonly width?: number;
}

/**
 * 페인 한 칸 — 캡션과 본문.
 *
 * **캡션은 detail 페인에만 선다.** primary는 표면과 수명을 같이하므로 닫을 것도 확대할 것도
 * 없고, 무엇인지는 레일 아이콘이 이미 말한다 — 거기에 이름 한 줄을 더 세우면 30px을 낭비하고
 * 같은 말을 두 번 하게 된다. aside도 본문에 종속된 부속 열이라 같은 이유로 캡션이 없다.
 *
 * 보이지 않는 keepAlive 페인도 렌더는 계속된다. 대신 `inert`와 `aria-hidden`으로 포커스와
 * 보조기술에서 빼고, 본문은 `ctx.visible`로 그 사실을 알아 폴링을 스스로 멈춘다.
 */
function PaneHost({
  descriptor,
  instanceId,
  params,
  visible,
  focused,
  theaterId,
  api,
  language,
  theme,
  surfaces,
  onRequestExtraWidth,
  onLaunchOperation,
  width,
}: PaneHostProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const paneIndex = usePaneIndex();

  // 요청받은 마운트가 확대면 확대 표면으로 보낸다. 스토어는 레일 열만 알고 있어서, 여기서
  // 갈라 주지 않으면 확대 요청이 조용히 사라진다.
  // 마운트를 생략한 요청은 **그 페인이 이미 서 있는 자리로** 간다. 확대해 둔 문서를 목록에서
  // 갈아탈 때 이 규칙이 없으면 같은 페인이 레일에도 함께 서고, 두 사본이 서로 다른 주소를 들고
  // 각자 자기 주소로 스토어를 되돌리려 들어 갱신이 멈추지 않는다.
  const handleOpen = useCallback((request: PaneOpenRequest) => {
    const target = paneIndex.get(request.paneId);
    const standing = isPaneExpanded(request.paneId) ? "expanded" : undefined;
    const mount = request.mount ?? standing ?? target?.mounts[0] ?? "rail";
    if (mount === "expanded") {
      // 확대 표면은 호스트 내장 기여다 — 능력 객체를 거치면 그것이 없는 조립에서 요청이
      // 조용히 사라진다. 여기서는 호스트가 자기 스토어를 직접 부른다.
      openExpandedPane(request.paneId, request.params);
      return;
    }
    openPane(request);
  }, [paneIndex]);

  // 남의 페인을 닫을 때도 그 페인의 keepAlive를 따른다. 자기를 닫을 때만 지켜 주면
  // 형제가 닫는 순간 터미널과 초안이 사라진다.
  const handleCloseOther = useCallback((paneId: string) => {
    const target = paneIndex.get(paneId);
    closePane(paneId, {
      keepAlive: target?.keepAlive === true,
      ...(target?.onClose ? { onClose: target.onClose } : {}),
    });
  }, [paneIndex]);

  const handleClose = useCallback(() => {
    closePane(descriptor.id, {
      keepAlive: descriptor.keepAlive === true,
      ...(descriptor.onClose ? { onClose: descriptor.onClose } : {}),
    });
  }, [descriptor]);

  const handleReplaceParams = useCallback((next: Readonly<Record<string, string>>) => {
    replacePaneParams(descriptor.id, next);
  }, [descriptor.id]);

  // 확대는 페인마다 만드는 기능이 아니라 표면 계약의 공통 동작이다 — 호스트 내장 표면이
  // paneId를 받아 같은 본문을 캔버스 위에 세운다. 그래서 이 버튼은 어떤 detail 페인에도
  // 같은 방식으로 선다.
  const canExpand = descriptor.mounts.includes("expanded");
  // 확대는 닫힘이 아니다 — 같은 본문이 자리를 옮기는 것이므로 닫힘 통보를 보내지 않는다.
  // 보내면 무엇을 읽고 있다는 사실을 플러그인이 스스로 지워, 옮겨 간 자리가 곧 비어 버린다.
  const handleExpand = useCallback(() => {
    openExpandedPane(descriptor.id, params);
    closePane(descriptor.id, { keepAlive: descriptor.keepAlive === true });
  }, [descriptor.id, descriptor.keepAlive, params]);

  const ctx = usePaneContext({
    descriptor,
    mount: "rail",
    instanceId,
    params,
    visible,
    focused,
    // 폭은 표면이 정한다. 본문은 컨테이너 쿼리로 스스로 열화하므로, 측정값을 렌더마다 흘리면
    // 컨텍스트가 매번 새로 만들어져 본문이 다시 그려진다.
    width: width ?? descriptor.defaultWidth ?? 0,
    theaterId,
    api,
    lifecycle: HOST_CAPABILITIES.lifecycle,
    preferences: HOST_CAPABILITIES.preferences,
    language,
    theme,
    onClose: handleClose,
    onReplaceParams: handleReplaceParams,
    onOpen: handleOpen,
    onCloseOther: handleCloseOther,
    ...(onRequestExtraWidth === undefined ? {} : { requestExtraWidth: onRequestExtraWidth }),
    legacySurfaces: surfaces,
    legacyLaunchOperation: onLaunchOperation,
  });

  const hasCaption = descriptor.role === "detail" && descriptor.hideCaption !== true;
  const title = resolveLocalizedText(descriptor.title(ctx), language);

  return (
    <div
      id={`rail-pane-${descriptor.id}`}
      className={`rail-pane role-${descriptor.role}${focused ? " is-focused" : ""}${visible ? "" : " is-parked"}${width === undefined ? "" : " is-sized"}`}
      data-pane={descriptor.id}
      hidden={!visible}
      aria-hidden={visible ? undefined : true}
      inert={visible ? undefined : true}
      style={width === undefined ? undefined : { ["--pane-width" as string]: `${width}px` }}
      onFocusCapture={() => { if (visible) focusPane(descriptor.id); }}
    >
      {hasCaption ? (
        <PaneCaption
          title={title}
          paneId={descriptor.id}
          focused={focused}
          actions={descriptor.captionActions?.(ctx) as ReactNode}
          {...(canExpand ? { onExpand: handleExpand } : {})}
          onClose={handleClose}
        />
      ) : null}
      <div className="rail-pane-body" ref={bodyRef} aria-labelledby={hasCaption ? `pane-caption-${descriptor.id}` : undefined}>
        <PaneBody descriptor={descriptor} ctx={ctx} />
      </div>
    </div>
  );
}

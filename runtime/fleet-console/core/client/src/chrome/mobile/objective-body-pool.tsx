import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { FeatureErrorBoundary } from "@fleet-console/ui/react";
import { findAgentObjectiveKind } from "../../../../../features/execution/shared/objective-kind.js";
import type { ClientMobileObjectiveCapability } from "../../../../../features/workspace/shared/mobile.js";
import type { ConsoleTheme } from "../../../../../features/settings/shared/theme.js";
import type { ObjectiveKindDescriptor, ObjectiveRenderContext, ObjectiveRuntimeState } from "../../../../../features/execution/shared/client-contract.js";

import { createHostCapabilities } from "../../integration/feature-capabilities.js";
import { useT } from "../../i18n/index.js";
import type { ObjectiveGeometry, ObjectiveRecord } from "../../integration/types.js";

export interface ObjectiveBodyConfig {
  readonly active: boolean;
  readonly keyboardFocusRequestId?: number;
  readonly geometry: ObjectiveGeometry;
  readonly objectiveRecord: ObjectiveRecord;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly zoom: number;
  readonly runtimeState: ObjectiveRuntimeState | null;
  /** Absent means live. Parked bodies force this off even when a slot later claims otherwise. */
  readonly bodyLive?: boolean;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: ObjectiveGeometry) => void;
  /** Absent on a host without companion panels; a plugin reads that absence and offers none. */
  readonly onRequestCompanions?: (open: boolean) => void;
  readonly companionsOpen?: boolean;
  readonly hiddenCompanionPanelIds?: readonly string[];
  readonly onSetCompanionPanelVisible?: (companionPanelId: string, visible: boolean) => void;
  /** 모바일 Objective 화면이 실어 주는 ⋮ 창구. 없으면 본문은 모바일 ⋮이 없는 호스트로 읽는다. */
  readonly mobileObjective?: ClientMobileObjectiveCapability;
}

interface PoolRegistry {
  readonly publish: (objectiveId: string, config: ObjectiveBodyConfig) => void;
  readonly attach: (
    objectiveId: string,
    slot: HTMLDivElement | null,
    lastVisibleSize?: ObjectiveBodySize,
    lastVisibleZoom?: number,
  ) => void;
}

interface ObjectiveBodySize {
  readonly width: number;
  readonly height: number;
}

const PoolRegistryContext = createContext<PoolRegistry | null>(null);

export function useObjectiveBodyPoolAvailable(): boolean {
  return useContext(PoolRegistryContext) !== null;
}

export function ObjectiveBodySlot({ objectiveId, config, className = "" }: {
  readonly objectiveId: string;
  readonly config: ObjectiveBodyConfig;
  readonly className?: string;
}) {
  const registry = useContext(PoolRegistryContext);
  if (!registry) throw new Error("ObjectiveBodySlot must be rendered inside ObjectiveBodyPool");
  const slotRef = useRef<HTMLDivElement | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  useLayoutEffect(() => {
    registry.publish(objectiveId, config);
  }, [config, objectiveId, registry]);
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      slotRef.current = element;
      registry.attach(objectiveId, element);
      return;
    }
    const previous = slotRef.current;
    slotRef.current = null;
    const width = previous?.clientWidth ?? 0;
    const height = previous?.clientHeight ?? 0;
    registry.attach(
      objectiveId,
      null,
      width > 0 && height > 0 ? { width, height } : undefined,
      configRef.current.zoom,
    );
  }, [objectiveId, registry]);
  return <div className={className} ref={attach} data-objective-body-slot={objectiveId} />;
}

export function ObjectiveBodyPool({ objectiveRecords, objectiveRecordKinds, capabilities, defaultConfig, releaseParkedBodies, children }: {
  readonly releaseParkedBodies: boolean;
  readonly objectiveRecords: readonly ObjectiveRecord[];
  readonly objectiveRecordKinds: readonly ObjectiveKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly defaultConfig: (objectiveRecord: ObjectiveRecord) => ObjectiveBodyConfig;
  readonly children: ReactNode;
}) {
  const configsRef = useRef(new Map<string, ObjectiveBodyConfig>());
  const slotsRef = useRef(new Map<string, HTMLDivElement>());
  const lastVisibleSizesRef = useRef(new Map<string, ObjectiveBodySize>());
  const lastVisibleZoomsRef = useRef(new Map<string, number>());
  const [slotRevision, setSlotRevision] = useState(0);
  const parkingRef = useRef<HTMLDivElement | null>(null);
  const attachParking = useCallback((element: HTMLDivElement | null) => {
    if (parkingRef.current === element) return;
    parkingRef.current = element;
    setSlotRevision((revision) => revision + 1);
  }, []);

  const registry = useMemo<PoolRegistry>(() => ({
    publish(objectiveId, config) {
      if (sameBodyConfig(configsRef.current.get(objectiveId), config)) return;
      configsRef.current.set(objectiveId, config);
      setSlotRevision((revision) => revision + 1);
    },
    attach(objectiveId, slot, lastVisibleSize, lastVisibleZoom) {
      const previous = slotsRef.current.get(objectiveId) ?? null;
      if (previous === slot) return;
      if (slot) slotsRef.current.set(objectiveId, slot);
      else {
        slotsRef.current.delete(objectiveId);
        configsRef.current.delete(objectiveId);
        if (lastVisibleSize) lastVisibleSizesRef.current.set(objectiveId, lastVisibleSize);
        if (lastVisibleZoom !== undefined) lastVisibleZoomsRef.current.set(objectiveId, lastVisibleZoom);
      }
      setSlotRevision((revision) => revision + 1);
    },
  }), []);

  return (
    <PoolRegistryContext.Provider value={registry}>
      {children}
      <div className="objective-body-parking" ref={attachParking} aria-hidden="true" inert>
        {objectiveRecords.map((objectiveRecord) => {
          const descriptor = findAgentObjectiveKind(objectiveRecordKinds);
          if (!descriptor?.render) return null;
          const config = configsRef.current.get(objectiveRecord.id) ?? defaultConfig(objectiveRecord);
          const parked = !slotsRef.current.has(objectiveRecord.id);
          // 데스크톱은 지금 슬롯에 선 본문만 둔다. 모바일 화면 사이 이동은 portal을 보존한다.
          if (releaseParkedBodies && parked) return null;
          const lastVisibleZoom = lastVisibleZoomsRef.current.get(objectiveRecord.id);
          const bodyConfig = parked && lastVisibleZoom !== undefined
            ? { ...config, zoom: lastVisibleZoom }
            : config;
          const parkingSize = lastVisibleSizesRef.current.get(objectiveRecord.id) ?? {
            width: config.geometry.width,
            height: config.geometry.height,
          };
          return (
            <PooledObjectiveBody
              key={objectiveRecord.id}
              objectiveRecord={objectiveRecord}
              descriptor={descriptor}
              config={bodyConfig}
              capabilities={capabilities}
              slot={slotsRef.current.get(objectiveRecord.id) ?? parkingRef.current}
              parked={parked}
              parkingSize={parkingSize}
              slotRevision={slotRevision}
            />
          );
        })}
      </div>
    </PoolRegistryContext.Provider>
  );
}

function sameBodyConfig(previous: ObjectiveBodyConfig | undefined, next: ObjectiveBodyConfig): boolean {
  if (!previous) return false;
  return previous.active === next.active
    && previous.keyboardFocusRequestId === next.keyboardFocusRequestId
    && previous.objectiveRecord === next.objectiveRecord
    && previous.geometry.x === next.geometry.x
    && previous.geometry.y === next.geometry.y
    && previous.geometry.width === next.geometry.width
    && previous.geometry.height === next.geometry.height
    && previous.geometry.zIndex === next.geometry.zIndex
    && previous.theme === next.theme
    && previous.language === next.language
    && previous.zoom === next.zoom
    && previous.onActivate === next.onActivate
    && previous.onClose === next.onClose
    && previous.onGeometryChange === next.onGeometryChange
    && previous.onRequestCompanions === next.onRequestCompanions
    && previous.companionsOpen === next.companionsOpen
    && previous.hiddenCompanionPanelIds === next.hiddenCompanionPanelIds
    && previous.onSetCompanionPanelVisible === next.onSetCompanionPanelVisible
    && previous.mobileObjective === next.mobileObjective
    && previous.bodyLive === next.bodyLive;
}

function PooledObjectiveBody({ objectiveRecord, descriptor, config, capabilities, slot, parked, parkingSize }: {
  readonly objectiveRecord: ObjectiveRecord;
  readonly descriptor: ObjectiveKindDescriptor;
  readonly config: ObjectiveBodyConfig;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly slot: HTMLDivElement | null;
  readonly parked: boolean;
  readonly parkingSize: ObjectiveBodySize;
  readonly slotRevision: number;
}) {
  const mountNode = useMemo(() => {
    const element = document.createElement("div");
    element.className = "objective-body-mount";
    element.dataset.objectiveRecordBodyMount = objectiveRecord.id;
    return element;
  }, [objectiveRecord.id]);
  const configRef = useRef(config);
  configRef.current = config;

  useLayoutEffect(() => {
    if (!slot || mountNode.parentElement === slot) return;
    if (parked) {
      mountNode.style.width = `${parkingSize.width}px`;
      mountNode.style.height = `${parkingSize.height}px`;
    } else {
      mountNode.style.removeProperty("width");
      mountNode.style.removeProperty("height");
    }
    slot.appendChild(mountNode);
  }, [mountNode, parked, parkingSize.height, parkingSize.width, slot]);

  // mountNode는 명령형으로 만든 DOM이라 portal 내용이 unmount돼도 React가 회수하지 않는다.
  // 정리는 이 전용 effect가 맡는다 — 위 슬롯 이동 effect의 cleanup에 넣으면 slot이 바뀔 때마다
  // 노드가 DOM에서 분리됐다 다시 붙어, 셸 전환 도중 xterm이 떨어져 나가고 FitAddon이 잘못된
  // 크기를 PTY로 보낸다. deps가 mountNode뿐이라 실제로는 언마운트 시점에만 돈다.
  useLayoutEffect(() => () => { mountNode.remove(); }, [mountNode]);

  const current = config;
  const t = useT();
  const context = {
    objectiveId: objectiveRecord.id,
    theaterId: objectiveRecord.theaterId,
    pluginId: "terminal",
    type: "agent",
    objectiveRecord,
    geometry: current.geometry,
    active: current.active,
    ...(current.keyboardFocusRequestId === undefined ? {} : { keyboardFocusRequestId: current.keyboardFocusRequestId }),
    zoom: current.zoom,
    theme: current.theme,
    language: current.language,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    objectiveRecords: capabilities.objectiveRecords,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    runtime: capabilities.runtime,
    runtimeState: current.runtimeState,
    // 주차는 슬롯이 없다는 뜻이다. config가 live라고 말해도 화면 밖에 있으면 스트림을 열지 않는다.
    bodyLive: parked ? false : current.bodyLive !== false,
    statusDetail: capabilities.statusDetail,
    composer: capabilities.composer,
    navigate: capabilities.navigate,
    shell: capabilities.shell,
    rail: capabilities.rail,
    onActivate: () => configRef.current?.onActivate(),
    onClose: () => configRef.current?.onClose(),
    onGeometryChange: (geometry: ObjectiveGeometry) => configRef.current?.onGeometryChange(geometry),
    // Forwarded only when the host declares them; wrapping an absent callback would turn "no
    // companions here" into a handler that exists and does nothing.
    onRequestCompanions: current.onRequestCompanions === undefined
      ? undefined
      : (open: boolean) => configRef.current?.onRequestCompanions?.(open),
    ...(current.mobileObjective === undefined ? {} : { mobileObjective: current.mobileObjective }),
    companionsOpen: current.companionsOpen,
    hiddenCompanionPanelIds: current.hiddenCompanionPanelIds,
    onSetCompanionPanelVisible: current.onSetCompanionPanelVisible === undefined
      ? undefined
      : (id: string, visible: boolean) => configRef.current?.onSetCompanionPanelVisible?.(id, visible),
  } satisfies ObjectiveRenderContext;

  return createPortal(
    <FeatureErrorBoundary fallback={<div className="fc-plugin-error">{t("workspace.plugin.objectiveRecordFailed")}</div>}>
      <PluginBody render={descriptor.render!} context={context} />
    </FeatureErrorBoundary>,
    mountNode,
  );
}

// render를 JSX children 자리에서 바로 호출하면 그 평가가 PooledObjectiveBody의 렌더 중에 일어난다.
// 그 시점에는 FeatureErrorBoundary가 아직 트리에 없어 플러그인의 동기 throw를 잡지 못하고 셸까지 올라간다.
// 호출을 바운더리 자식 컴포넌트 안으로 내려 캔버스 경로(PluginObjectiveRenderer)와 같은 보호를 유지한다.
function PluginBody({ render, context }: {
  readonly render: NonNullable<ObjectiveKindDescriptor["render"]>;
  readonly context: ObjectiveRenderContext;
}) {
  return <>{render(context) as ReactNode}</>;
}

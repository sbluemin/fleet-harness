import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { PluginErrorBoundary } from "@fleet-console/sdk/react/browser";
import type { ConsoleTheme, OperationKindDescriptor, OperationRenderContext } from "@fleet-console/sdk/plugin";

import { createHostCapabilities } from "../plugin-capabilities.js";
import { useT } from "../i18n/index.js";
import type { OperationGeometry, OperationNode } from "../types.js";

export interface OperationBodyConfig {
  readonly active: boolean;
  readonly keyboardFocusRequestId?: number;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: "en" | "ko";
  readonly zoom: number;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onRequestCompanions: (open: boolean) => void;
  readonly companionsOpen: boolean;
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void;
}

interface PoolRegistry {
  readonly publish: (operationId: string, config: OperationBodyConfig) => void;
  readonly attach: (operationId: string, slot: HTMLDivElement | null, lastVisibleSize?: OperationBodySize) => void;
}

interface OperationBodySize {
  readonly width: number;
  readonly height: number;
}

const PoolRegistryContext = createContext<PoolRegistry | null>(null);

export function useOperationBodyPoolAvailable(): boolean {
  return useContext(PoolRegistryContext) !== null;
}

export function OperationBodySlot({ operationId, config, className = "" }: {
  readonly operationId: string;
  readonly config: OperationBodyConfig;
  readonly className?: string;
}) {
  const registry = useContext(PoolRegistryContext);
  if (!registry) throw new Error("OperationBodySlot must be rendered inside OperationBodyPool");
  const slotRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    registry.publish(operationId, config);
  }, [config, operationId, registry]);
  const attach = useCallback((element: HTMLDivElement | null) => {
    if (element) {
      slotRef.current = element;
      registry.attach(operationId, element);
      return;
    }
    const previous = slotRef.current;
    slotRef.current = null;
    const width = previous?.clientWidth ?? 0;
    const height = previous?.clientHeight ?? 0;
    registry.attach(operationId, null, width > 0 && height > 0 ? { width, height } : undefined);
  }, [operationId, registry]);
  return <div className={className} ref={attach} data-operation-body-slot={operationId} />;
}

export function OperationBodyPool({ operations, operationKinds, capabilities, defaultConfig, children }: {
  readonly operations: readonly OperationNode[];
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly defaultConfig: (operation: OperationNode) => OperationBodyConfig;
  readonly children: ReactNode;
}) {
  const configsRef = useRef(new Map<string, OperationBodyConfig>());
  const slotsRef = useRef(new Map<string, HTMLDivElement>());
  const lastVisibleSizesRef = useRef(new Map<string, OperationBodySize>());
  const [slotRevision, setSlotRevision] = useState(0);
  const parkingRef = useRef<HTMLDivElement | null>(null);
  const attachParking = useCallback((element: HTMLDivElement | null) => {
    if (parkingRef.current === element) return;
    parkingRef.current = element;
    setSlotRevision((revision) => revision + 1);
  }, []);

  const registry = useMemo<PoolRegistry>(() => ({
    publish(operationId, config) {
      if (sameBodyConfig(configsRef.current.get(operationId), config)) return;
      configsRef.current.set(operationId, config);
      setSlotRevision((revision) => revision + 1);
    },
    attach(operationId, slot, lastVisibleSize) {
      const previous = slotsRef.current.get(operationId) ?? null;
      if (previous === slot) return;
      if (slot) slotsRef.current.set(operationId, slot);
      else {
        slotsRef.current.delete(operationId);
        configsRef.current.delete(operationId);
        if (lastVisibleSize) lastVisibleSizesRef.current.set(operationId, lastVisibleSize);
      }
      setSlotRevision((revision) => revision + 1);
    },
  }), []);

  return (
    <PoolRegistryContext.Provider value={registry}>
      {children}
      <div className="operation-body-parking" ref={attachParking} aria-hidden="true" inert>
        {operations.map((operation) => {
          const descriptor = operationKinds.find((kind) => kind.pluginId === operation.pluginId && kind.type === operation.type);
          if (!descriptor?.render) return null;
          const config = configsRef.current.get(operation.id) ?? defaultConfig(operation);
          const parked = !slotsRef.current.has(operation.id);
          const parkingSize = lastVisibleSizesRef.current.get(operation.id) ?? {
            width: config.geometry.width,
            height: config.geometry.height,
          };
          return (
            <PooledOperationBody
              key={operation.id}
              operation={operation}
              descriptor={descriptor}
              config={config}
              capabilities={capabilities}
              slot={slotsRef.current.get(operation.id) ?? parkingRef.current}
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

function sameBodyConfig(previous: OperationBodyConfig | undefined, next: OperationBodyConfig): boolean {
  if (!previous) return false;
  return previous.active === next.active
    && previous.keyboardFocusRequestId === next.keyboardFocusRequestId
    && previous.operation === next.operation
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
    && previous.onSetCompanionPanelVisible === next.onSetCompanionPanelVisible;
}

function PooledOperationBody({ operation, descriptor, config, capabilities, slot, parked, parkingSize }: {
  readonly operation: OperationNode;
  readonly descriptor: OperationKindDescriptor;
  readonly config: OperationBodyConfig;
  readonly capabilities: ReturnType<typeof createHostCapabilities>;
  readonly slot: HTMLDivElement | null;
  readonly parked: boolean;
  readonly parkingSize: OperationBodySize;
  readonly slotRevision: number;
}) {
  const mountNode = useMemo(() => {
    const element = document.createElement("div");
    element.className = "operation-body-mount";
    element.dataset.operationBodyMount = operation.id;
    return element;
  }, [operation.id]);
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
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
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
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    status: capabilities.status,
    onActivate: () => configRef.current?.onActivate(),
    onClose: () => configRef.current?.onClose(),
    onGeometryChange: (geometry: OperationGeometry) => configRef.current?.onGeometryChange(geometry),
    onRequestCompanions: (open: boolean) => configRef.current?.onRequestCompanions(open),
    companionsOpen: current.companionsOpen,
    hiddenCompanionPanelIds: current.hiddenCompanionPanelIds,
    onSetCompanionPanelVisible: (id: string, visible: boolean) => configRef.current?.onSetCompanionPanelVisible(id, visible),
  } satisfies OperationRenderContext;

  return createPortal(
    <PluginErrorBoundary fallback={<div className="fc-plugin-error">{t("canvas.plugin.operationFailed")}</div>}>
      {descriptor.render!(context) as ReactNode}
    </PluginErrorBoundary>,
    mountNode,
  );
}

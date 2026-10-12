import type { ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ConsoleTheme, OperationRenderContext, OperationRuntimeState, PluginInstallContext } from "@fleet-console/sdk/plugin";

import type { OperationGeometry, OperationNode } from "../../../core/client/src/integration/types.js";

export interface PluginOperationRendererProps {
  readonly active: boolean;
  readonly keyboardFocusRequestId?: number;
  readonly capabilities: PluginInstallContext;
  readonly geometry: OperationGeometry;
  readonly operation: OperationNode;
  readonly theme: ConsoleTheme;
  readonly language: ConsoleLocale;
  readonly viewportZoom: number;
  readonly runtimeState: OperationRuntimeState | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: OperationGeometry) => void;
  readonly onRequestCompanions: (open: boolean) => void;
  readonly companionsOpen: boolean;
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void;
  readonly companionPanelIds?: readonly string[];
  readonly bodyLive?: boolean;
  readonly render: (context: OperationRenderContext) => unknown;
}

/** 플러그인 렌더에 호스트 컨텍스트를 넘긴다. 대화 칸과 캔버스 프레임이 같은 호출 계약을 쓴다. */
export function PluginOperationRenderer({
  active,
  keyboardFocusRequestId,
  capabilities,
  geometry,
  operation,
  theme,
  language,
  viewportZoom,
  runtimeState,
  onActivate,
  onClose,
  onGeometryChange,
  onRequestCompanions,
  companionsOpen,
  hiddenCompanionPanelIds,
  onSetCompanionPanelVisible,
  companionPanelIds,
  bodyLive,
  render,
}: PluginOperationRendererProps) {
  return render({
    operationId: operation.id,
    theaterId: operation.theaterId,
    pluginId: operation.pluginId,
    type: operation.type,
    operation,
    geometry,
    active,
    ...(keyboardFocusRequestId === undefined ? {} : { keyboardFocusRequestId }),
    zoom: viewportZoom,
    theme,
    language,
    api: capabilities.api,
    lifecycle: capabilities.lifecycle,
    terminal: capabilities.terminal,
    notifications: capabilities.notifications,
    operations: capabilities.operations,
    preferences: capabilities.preferences,
    settings: capabilities.settings,
    runtime: capabilities.runtime,
    runtimeState,
    ...(bodyLive === undefined ? {} : { bodyLive }),
    statusDetail: capabilities.statusDetail,
    composer: capabilities.composer,
    navigate: capabilities.navigate,
    shell: capabilities.shell,
    rail: capabilities.rail,
    onActivate,
    onClose,
    onGeometryChange,
    onRequestCompanions,
    companionsOpen,
    hiddenCompanionPanelIds,
    onSetCompanionPanelVisible,
    ...(companionPanelIds === undefined ? {} : { companionPanelIds }),
  }) as ReactNode;
}

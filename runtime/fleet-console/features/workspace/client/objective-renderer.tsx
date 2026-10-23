import type { ClientRailCapability } from "../shared/navigation-ports.js";
import type { ClientShellCapability } from "../shared/navigation.js";
import type { ClientNavigateCapability } from "../shared/navigation.js";
import type { ClientComposerCapability } from "../../execution/shared/composer-ports.js";
import type { ClientObjectiveStatusDetailCapability } from "../../execution/shared/client-contract.js";
import type { ClientObjectiveRuntimeCapability } from "../../execution/shared/client-contract.js";
import type { ClientSettingsCapability } from "../../settings/shared/client-ports.js";
import type { ClientPreferencesCapability } from "../../settings/shared/client-ports.js";
import type { ClientObjectiveRecordsCapability } from "../../execution/shared/client-contract.js";
import type { ClientNotificationsCapability } from "../../execution/shared/notification-ports.js";
import type { ClientTerminalCapability } from "../../execution/shared/client-contract.js";
import type { ClientLifecycleCapability } from "@fleet-console/infra/http/client-ports";
import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";
import type { ReactNode } from "react";

import type { ConsoleLocale } from "@fleet-console/i18n";
import type { ConsoleTheme } from "../../settings/shared/theme.js";
import type { ObjectiveRenderContext, ObjectiveRuntimeState } from "../../execution/shared/client-contract.js";

import type { ObjectiveGeometry, ObjectiveRecord } from "../../../core/client/src/integration/types.js";

export interface PluginObjectiveRendererProps {
  readonly active: boolean;
  readonly keyboardFocusRequestId?: number;
  readonly capabilities: ObjectiveSurfaceDeps;
  readonly geometry: ObjectiveGeometry;
  readonly objectiveRecord: ObjectiveRecord;
  readonly theme: ConsoleTheme;
  readonly language: ConsoleLocale;
  readonly viewportZoom: number;
  readonly runtimeState: ObjectiveRuntimeState | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onGeometryChange: (geometry: ObjectiveGeometry) => void;
  readonly onRequestCompanions: (open: boolean) => void;
  readonly companionsOpen: boolean;
  readonly hiddenCompanionPanelIds: readonly string[];
  readonly onSetCompanionPanelVisible: (companionPanelId: string, visible: boolean) => void;
  readonly companionPanelIds?: readonly string[];
  readonly bodyLive?: boolean;
  readonly render: (context: ObjectiveRenderContext) => unknown;
}

/** 플러그인 렌더에 호스트 컨텍스트를 넘긴다. 대화 칸과 캔버스 프레임이 같은 호출 계약을 쓴다. */
export function PluginObjectiveRenderer({
  active,
  keyboardFocusRequestId,
  capabilities,
  geometry,
  objectiveRecord,
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
}: PluginObjectiveRendererProps) {
  return render({
    objectiveId: objectiveRecord.id,
    theaterId: objectiveRecord.theaterId,
    pluginId: "terminal",
    type: "agent",
    objectiveRecord,
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
    objectiveRecords: capabilities.objectiveRecords,
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

export interface ObjectiveSurfaceDeps {
  readonly api: ClientApiCapability;
  readonly lifecycle: ClientLifecycleCapability;
  readonly terminal: ClientTerminalCapability;
  readonly notifications: ClientNotificationsCapability;
  readonly objectiveRecords: ClientObjectiveRecordsCapability;
  readonly preferences: ClientPreferencesCapability;
  readonly settings: ClientSettingsCapability;
  readonly runtime: ClientObjectiveRuntimeCapability;
  readonly statusDetail: ClientObjectiveStatusDetailCapability;
  readonly composer: ClientComposerCapability;
  readonly navigate: ClientNavigateCapability;
  readonly shell: ClientShellCapability;
  readonly rail: ClientRailCapability;
}

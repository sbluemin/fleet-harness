import { createSettingsDocumentApi } from "../../../../features/settings/client/document-api.js";
import type { ConsoleClientCapabilities } from "./client-capabilities.js";
import { createObjectivesClient, objectivesCommodoreBoard } from "../../../../features/objectives/client/index.js";
import { createCommodoreClient } from "../../../../features/commodore/client/index.js";
import type { CommodoreClientHost } from "../../../../features/commodore/shared/contracts/client.js";
import { consoleExecution, installConsoleExecution } from "./execution.js";
import { createContext, useContext, useMemo } from "react";
import type { OnboardingContribution } from "../../../../features/onboarding/shared/types.js";
import type { ExpandedSurfaceDescriptor } from "../../../../features/workspace/shared/expanded-surface.js";
import type { FloatingWidgetDescriptor } from "../../../../features/workspace/shared/floating.js";
import type { NotificationKindDescriptor } from "../../../../features/execution/shared/notifications.js";
import type { ArchiveSectionDescriptor } from "../../../../features/execution/shared/archive-surfaces.js";
import type { OperationCaptionContribution, TheaterContribution, CommandBandEntryDescriptor, SidebarFooterEntryDescriptor, ComposerTopEntryDescriptor, PersistentComponentDescriptor } from "../../../../features/workspace/shared/surface-contracts.js";
import type { OperationCluster, OperationClusterSource } from "../../../../features/objectives/shared/operation-clusters.js";
import type { OperationKindDescriptor } from "../../../../features/execution/shared/client-contract.js";
import type { ClientFeatureDescriptor } from "../../../../features/workspace/shared/feature-surfaces.js";
import type { ConversationSurfaceDescriptor } from "../../../../features/workspace/shared/conversation-surfaces.js";
import type { PaneDescriptor } from "../../../../features/workspace/shared/pane.js";
import type { RailEntryDescriptor, RailPanelDescriptor } from "../../../../features/workspace/shared/rail.js";
import type { SettingsSectionDescriptor } from "../../../../features/settings/shared/types.js";
import type { TheaterInboxSectionDescriptor } from "../../../../features/workspace/shared/theater-inbox.js";
import { codexClient, installCodexClient } from "../../../../features/codex/client/index.js";
import { quotaClient, installQuotaClient } from "../../../../features/quota/client/index.js";
import { scuttlebuttClient, installScuttlebuttClient } from "../../../../features/scuttlebutt/client/index.js";
import { fileExplorerClient } from "../../../../features/file-explorer/client/index.js";
import { repositoryClient } from "../../../../features/repository/client/index.js";
const builtInPlugins = [codexClient, fileExplorerClient, repositoryClient, quotaClient, scuttlebuttClient];
import { expandedPaneSurface } from "../chrome/pane/expanded-pane-surface.js";

/** 발견됐지만 패널을 세우지 못한 플러그인. 화면이 "왜 없는지"를 말할 수 있게 남긴다. */
/** 레지스트리가 읽은 플러그인 대화 — 그 대화를 낸 플러그인 id 를 함께 쥔다. */
export type ResolvedConversationSurface = ConversationSurfaceDescriptor & { readonly pluginId?: string | undefined };
/** 레일 엔트리를 등록한 주체 — 엔트리 id와 플러그인 id는 서로 다른 이름이다. */
export type ResolvedRailEntry = RailEntryDescriptor & { readonly pluginId?: string };

/** 플러그인이 선언한 묶음 id를 호스트 색인의 정준 id로 바꾼다. */
export function operationClusterId(pluginId: string, localClusterId: string): string {
  return `${pluginId}:${localClusterId}`;
}

/** 대화가 대신하는 Theater Inbox 섹션의 정준 id — 대화를 낸 플러그인의 섹션 id 에 `<pluginId>:` 를 붙인다. */
export function conversationSurfaceInboxSectionId(surface: ResolvedConversationSurface, localSectionId: string): string {
  return surface.pluginId ? `${surface.pluginId}:${localSectionId}` : localSectionId;
}

export interface FeatureRegistry {
  readonly objectives: ReturnType<typeof createObjectivesClient>;
  install(deps: ConsoleClientCapabilities): () => void;
  readonly commodore: CommodoreClientHost;
  readonly providers: readonly ClientFeatureDescriptor[];
  readonly operationKinds: readonly OperationKindDescriptor[];
  readonly settingsSections: readonly SettingsSectionDescriptor[];
  readonly notificationKinds: readonly NotificationKindDescriptor[];
  readonly railPanels: readonly RailPanelDescriptor[];
  readonly railEntries: readonly ResolvedRailEntry[];
  readonly panes: readonly PaneDescriptor[];
  readonly persistentComponents: readonly PersistentComponentDescriptor[];
  /**
   * 대화 중심 화면의 가운데 칸에 서는 플러그인 대화 — id 는 플러그인이 준 그대로다(`ctx.conversation.open` 이 부르는 이름).
   * `pluginId` 는 그 대화가 대신하는 Theater Inbox 섹션의 정준 id(`<pluginId>:<id>`)를 맞추는 데 쓴다.
   */
  readonly conversationSurfaces: readonly ResolvedConversationSurface[];
  readonly floatingWidgets: readonly FloatingWidgetDescriptor[];
  readonly commandBandEntries: readonly CommandBandEntryDescriptor[];
  readonly sidebarFooterEntries: readonly SidebarFooterEntryDescriptor[];
  readonly composerTopEntries: readonly ComposerTopEntryDescriptor[];
  readonly expandedSurfaces: readonly ExpandedSurfaceDescriptor[];
  readonly operationCaptionContributions: readonly OperationCaptionContribution[];
  /** Theater 머리 표식·머리 아래 줄·동작(우클릭) 메뉴 항목 — id 는 `<pluginId>:<id>` 로 붙어 있다. */
  readonly theaterContributions: readonly TheaterContribution[];
  /** Theater Inbox 의 플러그인 섹션 — id 는 `<pluginId>:<id>` 로 붙어 있다. 호스트의 「Theater 설정」은 여기에 없다. */
  readonly theaterInboxSections: readonly TheaterInboxSectionDescriptor[];
  /** 모든 플러그인의 묶음을 한 원천으로 — id 는 `<pluginId>:<id>` 로 붙어 있다. */
  readonly operationClusters: OperationClusterSource;
  /** 보관함 시트의 플러그인 칸 — id 는 `<pluginId>:<id>` 로 붙어 있다. */
  readonly archiveSections: readonly ArchiveSectionDescriptor[];
  /** 플러그인의 온보딩 기여 — 엔진은 코어 기능의 온보딩 다음 순서로 보인다. */
  readonly onboarding: readonly OnboardingContribution[];
}

// 모듈 평가 때 createFeatureRegistry 가 돈다 — 그 안에서 읽는 상수는 이 줄보다 위에 있어야 한다(TDZ).
const NO_CLUSTERS: readonly OperationCluster[] = [];
/** 도구모음 Bridge의 끝 자리 — 부관의 글리프. 답 말풍선이 이 글리프를 닻으로 삼아 줄 끝에서 뜬다. */
export const DEPUTY_COMMAND_BAND_ENTRY_ID = "scuttlebutt:dock";
const EMPTY_FEATURE_REGISTRY: FeatureRegistry = createFeatureRegistry(builtInPlugins);

const FeatureRegistryContext = createContext<FeatureRegistry>(EMPTY_FEATURE_REGISTRY);

export const FeatureRegistryProvider = FeatureRegistryContext.Provider;

export async function loadFeatureRegistry(): Promise<FeatureRegistry> {
  return EMPTY_FEATURE_REGISTRY;
}

export function useFeatureRegistry(): FeatureRegistry {
  return useContext(FeatureRegistryContext);
}

function createFeatureRegistry(plugins: readonly ClientFeatureDescriptor[]): FeatureRegistry {
  const commodore = createCommodoreClient(objectivesCommodoreBoard);
  const objectives = createObjectivesClient(commodore.host);
  const providers: readonly ClientFeatureDescriptor[] = [consoleExecution, commodore.plugin, ...plugins, objectives.surface];
  const railPanelIds = new Set<string>();
  const railPanels: RailPanelDescriptor[] = [];
  // 표면 id는 페인 저장소가 쓰는 주소다. rail 패널과 같은 규칙으로 접두 없이 두고
  // 선착순 중복 제거한다 — 접두를 붙이면 플러그인이 자기 지역 id로 부르는 open/close가
  // 승격된 id와 어긋나고, 능력이 플러그인별로 만들어지지 않는 한 그 간극을 메울 수 없다.
  // 대신 계약이 "콘솔 전체에서 유일"을 요구하고, 어긴 기여는 아래 경고로 드러난다.
  const expandedSurfaceIds = new Set<string>();
  const expandedSurfaces: ExpandedSurfaceDescriptor[] = [];
  for (const plugin of providers) {
    for (const surface of plugin.expandedSurfaces ?? []) {
      if (expandedSurfaceIds.has(surface.id)) {
        console.warn(`Skipping expanded surface with duplicate id: ${surface.id}`);
        continue;
      }
      expandedSurfaceIds.add(surface.id);
      expandedSurfaces.push(surface);
    }
  }
  for (const plugin of providers) {
    for (const panel of plugin.railPanels ?? []) {
      if (railPanelIds.has(panel.id)) {
        console.warn(`Skipping rail panel with duplicate id: ${panel.id}`);
        continue;
      }
      railPanelIds.add(panel.id);
      railPanels.push(panel);
    }
  }
  // 새 계약. 엔트리와 페인은 같은 이름공간 규칙을 따른다 — 접두 없이 선착순이며, 옛 패널과
  // id가 겹치면 여기 등록된 쪽이 이긴다(투영은 pane-registry가 그때 버린다).
  const railEntryIds = new Set<string>();
  const railEntries: ResolvedRailEntry[] = [];
  const paneIds = new Set<string>();
  const panes: PaneDescriptor[] = [];
  for (const plugin of providers) {
    for (const entry of plugin.railEntries ?? []) {
      if (railEntryIds.has(entry.id)) {
        console.warn(`Skipping rail entry with duplicate id: ${entry.id}`);
        continue;
      }
      railEntryIds.add(entry.id);
      railEntries.push({ ...entry, pluginId: plugin.id ?? "core" });
    }
    for (const pane of plugin.panes ?? []) {
      if (paneIds.has(pane.id)) {
        console.warn(`Skipping pane with duplicate id: ${pane.id}`);
        continue;
      }
      paneIds.add(pane.id);
      panes.push(pane);
    }
  }
  return {
    install(deps) {
      const cleanups = [installConsoleExecution(deps), commodore.install({ chat: deps.chat, rail: deps.rail, api: deps.api, consoleEvents: deps.consoleEvents, consoleState: deps.consoleState, experiments: deps.experiments, models: deps.models, composer: deps.composer, conversation: deps.conversation, theaterInbox: deps.theaterInbox, operations: deps.operations, navigate: deps.navigate }), objectives.install({ api: deps.api, consoleEvents: deps.consoleEvents, consoleState: deps.consoleState, operations: deps.operations, preferences: deps.preferences, runtime: deps.runtime, rail: deps.rail, conversation: deps.conversation, models: deps.models, navigate: deps.navigate, navigation: deps.navigation, composer: deps.composer, surfaces: deps.surfaces, notifications: deps.notifications }), installCodexClient({ consoleState: deps.consoleState, navigation: deps.navigation, surfaces: deps.surfaces, rail: deps.rail, composer: deps.composer, operations: deps.operations, consoleEvents: deps.consoleEvents }), installQuotaClient({ api: deps.api, settings: createSettingsDocumentApi("/api/v1/settings/quota") }), installScuttlebuttClient({ consoleState: deps.consoleState, experiments: deps.experiments, models: deps.models, settings: createSettingsDocumentApi("/api/v1/settings/scuttlebutt") })];
      return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
    },
    objectives,
    commodore: commodore.host,
    providers,
    persistentComponents: providers.flatMap((plugin) => plugin.persistentComponents ?? []),
    conversationSurfaces: providers.flatMap((plugin) => (plugin.conversationSurfaces ?? []).map((descriptor) => ({ ...descriptor, pluginId: plugin.id ?? undefined }))),
    onboarding: providers.flatMap((plugin) => (plugin.onboarding ? [plugin.onboarding] : [])),
    operationKinds: providers.flatMap((plugin) => plugin.operationKinds ?? []),
    settingsSections: providers.flatMap((plugin) => plugin.settingsSections ?? []),
    notificationKinds: providers.flatMap((plugin) => plugin.notificationKinds ?? []),
    railPanels,
    railEntries: [...railEntries.filter((entry) => entry.id === "codex"), ...railEntries.filter((entry) => entry.id !== "codex")],
    panes,
    floatingWidgets: providers.flatMap((plugin) => (plugin.floatingWidgets ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    }))),
    commandBandEntries: deputyLast(providers.flatMap((plugin) => (plugin.commandBandEntries ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    })))),
    sidebarFooterEntries: providers.flatMap((plugin) => (plugin.sidebarFooterEntries ?? []).map((descriptor) => ({ ...descriptor, id: `${plugin.id}:${descriptor.id}` }))),
    composerTopEntries: providers.flatMap((plugin) => (plugin.composerTopEntries ?? []).map((descriptor) => ({ ...descriptor, id: `${plugin.id}:${descriptor.id}` }))),
    expandedSurfaces,
    operationCaptionContributions: providers.flatMap((plugin) => (plugin.operationCaptionContributions ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    }))),
    theaterContributions: providers.flatMap((plugin) => (plugin.theaterContributions ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    }))),
    theaterInboxSections: providers.flatMap((plugin) => (plugin.theaterInboxSections ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    }))),
    archiveSections: providers.flatMap((plugin) => (plugin.archiveSections ?? []).map((descriptor) => ({
      ...descriptor,
      id: `${plugin.id}:${descriptor.id}`,
    }))),
    operationClusters: combineClusterSources(providers.flatMap((plugin) => (plugin.operationClusters ? [{ pluginId: plugin.id ?? "core", source: plugin.operationClusters }] : []))),
  };
}
/**
 * Bridge 순서: 부관은 늘 끝이고, 나머지(사용 한도 요약 등)는 합성 순서대로 그 앞에 선다. SDK에 순서 필드를
 * 두지 않고 호스트가 한 자리만 고정한다(레일의 codex 앞세우기와 같은 방식) — 외부 플러그인이 붙어도 부관 앞이다.
 */
function deputyLast(entries: readonly CommandBandEntryDescriptor[]): readonly CommandBandEntryDescriptor[] {
  return [...entries.filter((entry) => entry.id !== DEPUTY_COMMAND_BAND_ENTRY_ID), ...entries.filter((entry) => entry.id === DEPUTY_COMMAND_BAND_ENTRY_ID)];
}

/**
 * 여러 플러그인의 묶음 원천을 하나로. 어느 원천도 참조가 바뀌지 않았으면 합친 배열도 같은 참조를 돌려준다 —
 * 사이드바·대화 화면이 useSyncExternalStore 로 읽으므로 참조가 흔들리면 매 사건마다 다시 그린다.
 */
export function combineClusterSources(sources: readonly { readonly pluginId: string; readonly source: OperationClusterSource }[]): OperationClusterSource {
  if (sources.length === 0) return { subscribe: () => () => undefined, get: () => NO_CLUSTERS };
  let seen: readonly (readonly OperationCluster[])[] = [];
  let combined: readonly OperationCluster[] = NO_CLUSTERS;
  return {
    subscribe: (listener) => {
      const offs = sources.map(({ source }) => { try { return source.subscribe(listener); } catch { return () => undefined; } });
      return () => { for (const off of offs) off(); };
    },
    get: () => {
      const current = sources.map(({ source }) => { try { return source.get(); } catch { return NO_CLUSTERS; } });
      if (current.length === seen.length && current.every((list, index) => list === seen[index])) return combined;
      seen = current;
      combined = current.flatMap((list, index) => list.map((cluster) => ({ ...cluster, id: operationClusterId(sources[index]!.pluginId, cluster.id) })));
      return combined;
    },
  };
}

/** 표면 id → 서술자. 레이어가 페인마다 조회하므로 배열이 아니라 맵으로 준다. */
export function useExpandedSurfaceDescriptors(): ReadonlyMap<string, ExpandedSurfaceDescriptor> {
  const { expandedSurfaces } = useFeatureRegistry();
  return useMemo(
    // 페인 호스트는 코어 기여다 — 어떤 detail 페인이든 확대할 수 있게 하는 공통 표면이라,
    // 플러그인마다 자기 확대 표면을 만들 필요를 없앤다.
    () => new Map([expandedPaneSurface, ...expandedSurfaces].map((descriptor) => [descriptor.id, descriptor])),
    [expandedSurfaces],
  );
}

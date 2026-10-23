import type { OnboardingContribution } from "../../onboarding/shared/types.js";
import type { TheaterInboxSectionDescriptor } from "./theater-inbox.js";
import type { ReactNode } from "react";
import type { PaneDescriptor } from "./pane.js";
import type { ExpandedSurfaceDescriptor } from "./expanded-surface.js";
import type { FloatingWidgetDescriptor } from "./floating.js";
import type { OperationLaunchKind, OperationNode } from "../../execution/shared/operations/types.js";
import type { RailEntryDescriptor, RailPanelDescriptor } from "./rail.js";
import type { NotificationKindDescriptor } from "../../execution/shared/notifications.js";
import type { ExperimentModelOption } from "../../settings/shared/experiments.js";
import type { SettingsSectionDescriptor } from "../../settings/shared/types.js";
import type { LaunchContext, OperationKindDescriptor } from "../../execution/shared/client-contract.js";
import type { MentionTargetDescriptor } from "../../execution/shared/composer-ports.js";
import type { CommandBandEntryDescriptor, SidebarFooterEntryDescriptor, ComposerTopEntryDescriptor, PersistentComponentDescriptor, OperationCaptionContribution, TheaterContribution } from "./surface-contracts.js";
import type { ConversationSurfaceDescriptor } from "./conversation-surfaces.js";
import type { ArchiveSectionDescriptor } from "../../execution/shared/archive-surfaces.js";
import type { OperationClusterSource } from "../../objectives/shared/operation-clusters.js";
export interface ClientFeatureDescriptor {
  readonly id: string | null;
  readonly operationKinds?: readonly OperationKindDescriptor[];
  readonly settingsSections?: readonly SettingsSectionDescriptor[];
  readonly notificationKinds?: readonly NotificationKindDescriptor[];
  /**
   * @deprecated 진입점·본문·검색·기본폭을 한 객체에 묶는 옛 계약. `railEntries` + `panes`로
   * 나눠 등록하라. 호스트는 당분간 둘 다 받아 하나의 레지스트리로 합성한다.
   */
  readonly railPanels?: readonly RailPanelDescriptor[];
  /** 우측 레일의 아이콘 진입점. 무엇을 여는지는 `panes` 또는 `activate`가 말한다. */
  readonly railEntries?: readonly RailEntryDescriptor[];
  /**
   * 이 플러그인의 온보딩(레일 진입점 힌트·투어). 호스트는 Console 코어 기능의 온보딩을
   * 먼저 마친 뒤 같은 단계 순서로 이어서 보인다. 문구와 앵커는 플러그인이 소유한다.
   */
  readonly onboarding?: OnboardingContribution;
  /**
   * 표면 안의 열. 레일 표면과 확대 표면 어디에나 설 수 있고, 등록은 서로 독립이다 —
   * 어느 페인이 언제 서는지는 등록이 아니라 `panes.open` 호출이 정한다.
   */
  readonly panes?: readonly PaneDescriptor[];
  readonly floatingWidgets?: readonly FloatingWidgetDescriptor[];
  /**
   * 도구모음의 Bridge 칸(접어도 남는 끝 칸)에 서는 24px 항목. 플러그인이 자기 상태를 도구모음에
   * 상주시키는 자리다 — 호스트는 슬롯의 자리와 순서만 소유하고 본문은 플러그인이 그린다. 비어 있는
   * 항목은 아무것도 그리지 않으면(null) 자리를 차지하지 않는다.
   */
  readonly commandBandEntries?: readonly CommandBandEntryDescriptor[];
  /** 사이드바 맨 아래 아바타 옆의 요약 칸. Command Band 와 독립적으로 등록한다. */
  readonly sidebarFooterEntries?: readonly SidebarFooterEntryDescriptor[];
  /** 사령관·그룹 대화가 명시적으로 여는 컴포저 위쪽 요약 칸. */
  readonly composerTopEntries?: readonly ComposerTopEntryDescriptor[];
  /**
   * 캔버스를 덮는 확대 작업면. 슬롯 기하·포커스·주소는 호스트가 소유하고 플러그인은
   * 본문만 그린다. 여러 표면이 세로로 나뉘어 동시에 설 수 있다.
   */
  readonly expandedSurfaces?: readonly ExpandedSurfaceDescriptor[];
  /**
   * 다른 플러그인이 소유한 Operation 의 캡션·사이드바 칩에 얹는 표식.
   *
   * `captionActions`·`operationMarks` 는 Operation 종류의 소유자만 그린다. 그러나 "이 Operation 이 어느 목표에
   * 연결돼 있는가"처럼 Operation 을 소유하지 않는 플러그인이 아는 사실도 그 자리에 서야 한다. 호스트가 캡션의
   * 액션 무리 앞과 칩의 이름 뒤에 그린다. 그릴 것이 없으면 null 을 돌려주고, 그러면 자리도 없다.
   */
  readonly operationCaptionContributions?: readonly OperationCaptionContribution[];
  /**
   * Theater 하나에 딸린 플러그인의 자리 — 사이드바 Theater 머리의 표식·이름 물결·머리가 여는 Inbox 칸, 머리 바로 아래 줄, Theater 동작(우클릭) 메뉴의 항목.
   *
   * Theater 머리와 메뉴는 코어가 소유하지만, Theater 단위로 도는 플러그인의 상태(예: 그 Theater 를 운영하는 세션)는
   * 플러그인이 안다. 호스트는 자리·순서·접힘·메뉴의 키보드 이동만 소유하고 본문은 플러그인이 그린다. Operation 단위의
   * `operationMenu`·`operationMarks` 와 같은 모양이다.
   */
  readonly theaterContributions?: readonly TheaterContribution[];
  /**
   * Theater Inbox 의 섹션 — Theater 하나의 시트에서 호스트의 「Theater 설정」 곁에 서는 플러그인 소유 칸 묶음.
   * 시트 틀·주소·목록·키보드·포커스 복귀는 호스트가 소유하고, 섹션은 제목·칸·본문만 준다. id 는 `<pluginId>:<id>` 로 붙는다.
   */
  readonly theaterInboxSections?: readonly TheaterInboxSectionDescriptor[];
  /**
   * 한 실행 구조에 묶인 Operation 들 — 뿌리(조율자) 하나와 선후 관계를 가진 구성원(단계)들.
   *
   * 그룹은 사람이 정리하는 목록이고, 묶음은 플러그인이 아는 실행 구조다. 호스트는 관계·라벨·진행만 받아 뿌리의
   * 캡션에 진척도 띠(와 단계 목록), 뿌리 패널 본문에 구성원 세션으로 바꿔 보는 노드 줄(「N 노드」, N 은 members
   * 선언 순서의 자리)을 그린다. 묶음은 그리기만 한다 — 구성원이 목록 표면에 서지 않게 하는 것은 코어의 부모 `childSessions`
   * 저장 관계이고, 진행의 진실은 플러그인 쪽에 남는다.
   * `get()` 은 바뀌지 않았으면 같은 참조를 돌려줘야 한다(useSyncExternalStore).
   */
  readonly operationClusters?: OperationClusterSource;
  /**
   * 보관함 시트 안의 칸 — 플러그인이 소유한 "끝났거나 치운 것"(완료한 목표·정리한 목표)이 Core 의 보관된 세션 곁에 선다.
   * 호스트는 칸의 자리·머리·사이드바 보관함 입구의 개수만 그리고, 본문과 복원·영구 삭제는 플러그인이 그린다.
   * 개수가 0 인 칸은 서지 않는다. `count` 는 바뀌지 않았으면 같은 값을 돌려준다(useSyncExternalStore).
   */
  readonly archiveSections?: readonly ArchiveSectionDescriptor[];
  /**
   * 콘솔이 살아 있는 동안 호스트가 계속 마운트해 두는 화면 없는 기여.
   *
   * rail 패널도 확대 표면도 열려 있을 때만 마운트되므로, 주소 동기화처럼 "열려 있지
   * 않아도 돌아야 하는" React 로직은 설 자리가 없다. 그런 로직을 어느 화면 안에 얹으면
   * 그 화면이 닫히는 순간 조용히 멈춘다.
   *
   * 호스트는 이 기여를 라우팅 위에서 마운트하므로 훅이 주소 변화에 반응할 수 있고,
   * 아무것도 그리지 않는 것이 정상이다(`null` 반환).
   */
  readonly persistentComponents?: readonly PersistentComponentDescriptor[];
  /**
   * 대화 중심 화면(실험 기능)의 가운데 칸에 서는 플러그인 대화 — Operation 대신 플러그인이 소유한 대화(예: 사령관)를
   * 세운다. 호스트는 칸의 자리·머리 pill·오른쪽 패널 앞 묶음의 탭 자리를 소유하고, 본문과 탭 본문은 플러그인이 그린다.
   * 여는 것은 `ctx.conversation.open(id)` 이다. 대화 중심 화면이 꺼져 있으면 호스트는 이 기여를 읽지 않는다.
   */
  readonly conversationSurfaces?: readonly ConversationSurfaceDescriptor[];
  readonly launch?: (ctx: LaunchContext) => Promise<{ readonly id: string }>;
  readonly closeOperation?: (operationId: string) => void | Promise<void>;
  /**
   * Optional host→plugin resume request for a dormant Operation (e.g. a palette command).
   * Plugins without resumable sessions omit it; the host falls back to focusing the Operation.
   */
  readonly resumeOperation?: (operationId: string) => void | Promise<void>;
  /**
   * Operation types (OperationNode.type) this plugin accepts host-forwarded user
   * messages for. New session `@` mentions list only Operations whose plugin declares
   * their type here alongside `messageOperation`.
   */
  readonly messageableOperationTypes?: readonly string[];
  /**
   * Host→plugin request to deliver user text to an Operation's live session.
   * A dormant Operation is resumed by the plugin before delivery. Optional attachment
   * ids (from `uploadLaunchAttachment`) ride along and the plugin's server composes
   * the stored file paths after the text. Rejects with an Error whose `message` is
   * the server rejection code when one is available.
   */
  readonly messageOperation?: (operationId: string, text: string, attachmentIds?: readonly string[]) => Promise<void>;
  /**
   * 지금 행선지가 될 수 있는 비-Operation 대상들. 덱이 열릴 때마다 다시 읽히므로 설정으로
   * 켜고 끈 결과가 그대로 반영된다 — 정적 배열로 두면 로스터가 마운트 시점에 굳는다.
   * 이 함수와 `messageMentionTarget`을 **함께** 선언한 플러그인의 대상만 덱에 오른다.
   */
  readonly mentionTargets?: () => readonly MentionTargetDescriptor[];
  /** 근무표·로케일·권한이 바뀌면 호스트가 목록과 선택 좌표를 다시 읽는다. */
  readonly subscribeMentionTargets?: (listener: () => void) => () => void;
  /**
   * Host→plugin request to deliver user text to a non-Operation mention target.
   * `targetId` is the plugin-local `MentionTargetDescriptor.id`. Attachments are not
   * forwarded — the host refuses that combination before calling. Rejects with an Error
   * whose `message` is the server rejection code when one is available.
   * 답은 플러그인이 자기 표면에서 보여 준다 — 세션은 계속 플러그인이 소유하며, 컴포저 마운트나 이 전달 promise의 수명에 매이지 않는다.
   */
  readonly messageMentionTarget?: (targetId: string, text: string) => Promise<void>;
  /**
   * Host→plugin upload of a new session image attachment. The plugin stores the bytes
   * server-side and returns an opaque id only — absolute storage paths never enter the
   * browser. The returned id rides the launch variant (`attachments`, comma-joined) and
   * the plugin's launch path forwards it to the server. Rejects with an Error whose
   * `message` is the server rejection code when one is available.
   */
  readonly uploadLaunchAttachment?: (file: Blob) => Promise<{ readonly id: string }>;
  /** Best-effort discard of an uploaded-but-unsent attachment (composer chip removal). */
  readonly discardLaunchAttachment?: (id: string) => Promise<void>;
  readonly renderLaunchIcon?: (kind: OperationLaunchKind) => ReactNode;
  /**
   * @deprecated 모델 선택지는 이제 코어의 모델 로스터(`ctx.models`) 하나가 소유한다. 호스트는 이 값을 더 읽지 않는다.
   * Fleet 1.215.0에서 제거한다.
   */
  /**
   * 사이드바 묶음 줄 선택과 「더블클릭으로 열기」 사이드바의 한 번 클릭(열지 않는 선택) 시 호출된다(이름은 옛 맵 화면에서 이어진 계약이다).
   * 이 알림은 키보드 포커스 이동을 뜻하지 않는다.
   */
}

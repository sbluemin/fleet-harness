import type { MongleState } from "./avatars.js";
import type { ReactNode } from "react";
import type { LocalizedText } from "@fleet-console/i18n";
import type { ConsoleTheme } from "../../settings/shared/theme.js";
import type { ObjectiveCluster } from "../../objectives/shared/objective-clusters.js";
/** 가운데 칸에 선 플러그인 대화가 받는 문맥. `params` 는 연 쪽이 넘긴 값 그대로다(호스트는 해석하지 않는다). */
export interface ConversationSurfaceContext {
  readonly params: Readonly<Record<string, unknown>>;
  readonly language: "en" | "ko";
  readonly theme: ConsoleTheme;
  /** 이 대화를 걷는다 — 가운데 칸은 직전에 보던 Objective 대화로 돌아간다. */
  readonly close: () => void;
  /**
   * 이 대화가 대신하는 Objective(`standInObjectiveId`)의 그룹 입력창 — 호스트가 그 id 의 묶음 대화 계약(`ObjectiveCluster.conversation`)
   * 으로 그린다. 아직 서지 않은 Objective 이라 보드 동작(`GroupConversationActions.board`)이 입력창의 일이다. 대신하는 Objective 이
   * 없거나 구버전 호스트면 없다.
   */
  readonly composer?: () => ReactNode;
}


/** 오른쪽 패널 앞 묶음의 탭 하나. 대화가 선 동안만 서고, 레일의 독점 슬롯·폭 기억을 그대로 받는다. id 는 레일 전체에서 고유해야 한다. */
export interface ConversationSurfaceTab {
  readonly id: string;
  readonly title: LocalizedText;
  readonly icon?: ReactNode;
  readonly defaultWidth?: number;
  readonly render: (ctx: ConversationSurfaceContext) => ReactNode;
  /** 이 탭이 대신하는 Theater Inbox 칸(대화의 `theater().inboxSection` 안의 page id). 그 칸을 여는 요청이 이 탭을 연다. */
  readonly inboxPage?: string;
  /**
   * 오른쪽 패널에서 본문이 서는 꼴. 생략하면 `"read"` — 호스트가 패널 머리와 같은 축의 가운데 읽기 열에 본문을 세우고 세로 스크롤을
   * 맡는다. 스크롤·폭을 스스로 가져야 하는 본문(바닥에 붙는 기록, 표·그래프)만 `"fill"` 로 칸 전체를 받는다. 구버전 호스트는 무시한다.
   */
  readonly layout?: ConversationPanelLayout;
}


/** 대화 중심 화면 오른쪽 패널의 본문 배치 — 기본 읽기 열(`read`) 또는 칸 전체(`fill`). */
export type ConversationPanelLayout = "read" | "fill";


export interface ConversationSurfaceDescriptor {
  /** `ctx.conversation.open` 이 부르는 이름. 플러그인 사이에서 고유해야 한다. */
  readonly id: string;
  /** 머리 pill 의 이름과 부제. */
  readonly title: (ctx: ConversationSurfaceContext) => string;
  readonly subtitle?: (ctx: ConversationSurfaceContext) => string | null;
  /** 머리 pill 의 표식(16px 안팎) — `avatar` 가 없을 때만 선다. 둘 다 없으면 글만 선다. */
  readonly mark?: () => ReactNode;
  /**
   * 이 대화의 주인(예: 사령관 대화면 그 Theater)의 몽글 아바타 키와 역할. 있으면 호스트가 머리 pill 에 20px, 오른쪽 패널 머리에 64px
   * 아바타를 세우고 대화 중심 화면에서 고칠 수 있게 한다. 없으면 `mark` 가 두 자리에 선다.
   * `state` 는 그 주인의 지금 얼굴(`mongleStateOf` 로 고른 값)이다 — 생략하면 쉼(idle)이다. 값이 바뀌면 `subscribe` 로 알린다.
   */
  readonly avatar?: (ctx: ConversationSurfaceContext) => { readonly key: string; readonly role: import("./avatars.js").MongleRole; readonly label: string; readonly state?: import("./avatars.js").MongleState } | null;
  /** `avatar`(와 머리의 다른 값)가 읽는 플러그인 상태가 바뀌면 깨운다 — 호스트가 머리 pill·오른쪽 패널 머리를 다시 그린다. */
  readonly subscribe?: (listener: () => void) => () => void;
  readonly render: (ctx: ConversationSurfaceContext) => ReactNode;
  /**
   * 머리 pill 바로 오른쪽 단추 묶음(Objective 대화의 pill 단추 묶음과 같은 자리·같은 캡슐)에 설 이 대화의 동작. 호스트가 자리와 면을
   * 진다 — 그 줄은 Desktop 에서 창을 끄는 자리라, 본문이 맨 위 줄에 단추를 띄우면 pill 밖에서는 눌리지 않는다. 없거나 null 이면 묶음이 서지 않는다.
   */
  readonly actions?: (ctx: ConversationSurfaceContext) => ReactNode;
  readonly tabs?: readonly ConversationSurfaceTab[];
  /** 열 때 오른쪽 패널이 닫혀 있으면 이 탭을 연다. */
  readonly defaultTab?: string;
  /** 데스크톱 배치를 떠나 표면을 걷기 직전 한 번 부른다. tabId 는 활성 오른쪽 패널 id 이며, 없으면 null 이다. 폰 착지는 플러그인이 정한다. */
  readonly onLeaveDesktop?: (context: { readonly params: Readonly<Record<string, unknown>>; readonly tabId: string | null }) => void;
  /**
   * 이 대화가 대신하는 Theater 와 그 Theater Inbox 섹션(플러그인 자기 섹션 id). 대화 중심 화면은 Inbox 시트 대신 오른쪽 패널에
   * Theater 를 세우는데, 이 대화가 가운데 칸에 선 동안 그 섹션 자리에는 이 대화의 탭이 선다(섹션 이름 아래, Theater 설정 곁).
   */
  readonly theater?: (ctx: ConversationSurfaceContext) => { readonly theaterId: string; readonly inboxSection: string } | null;
  /**
   * 이 대화가 아직 서지 않은 Objective 대화를 대신하면 그 Objective id(예: 시작 전 목표 — 개시하면 그 id 의 지휘관이 선다). 있으면
   * 오른쪽 패널이 Objective 대화와 같은 머리로 선다 — 작전구역 도구 줄 대신 대화 도구(`conversationTab`)가 글자 탭으로 서고, 그 id 의
   * 묶음 대화(`ObjectiveCluster.conversation`)가 있으면 「구성원」 탭이 그 명부를 보인다. 없거나 null 이면 플러그인 대화의 머리다.
   */
  readonly standInObjectiveId?: (ctx: ConversationSurfaceContext) => string | null;
  /**
   * 이 대화의 에이전트 세션이 쓰는 플릿 브라우저 — 서버에서 그 세션을 만들 때 `tools.browser` 로 준 `scopeId` 를 돌려준다.
   * 있으면 호스트가 머리 pill 바로 옆(대화 동작 맨 앞)에 Objective 대화와 같은 지구본을 세우고, 누르면 이 플러그인 id 와
   * scopeId 로 찾은 플릿 브라우저를 대화 옆 칸에 연다. 세션이 아직 한 번도 서지 않았으면 가짜 세션을 만들지 않고 까닭만 말한다.
   * 없거나 null 이면 지구본을 세우지 않는다. `attach` 를 주면 그 칸 브라우저의 「주석 첨부」·「스크린샷 첨부」가 이 대화의 입력창에
   * 이미지를 붙인다(보내지는 않는다). 없으면 그 칸에서 첨부할 곳이 없다.
   */
  readonly sessionBrowser?: (ctx: ConversationSurfaceContext) => { readonly scopeId: string; readonly attach?: (files: readonly File[]) => void } | null;
}


export interface ClientConversationCapability {
  /** 대화 중심 화면이 지금 서 있는가(데스크톱 + 실험 기능 켬). 꺼져 있으면 플러그인은 지금까지의 표면을 쓴다. */
  isActive(): boolean;
  /** 켜짐·꺼짐과 지금 선 대화가 바뀌면 깨운다. */
  subscribe(listener: () => void): () => void;
  /**
   * 가운데 칸에 대화를 세운다. 꺼져 있으면 아무 일도 하지 않고 false 를 돌려준다. 대화가 한 Theater 의 것이면 등록된 Theater id 를
   * `params.theaterId`(문자열)로 싣는다 — 호스트는 그 값을 가운데 대화의 Theater 로 읽어 머리 도구모음·오른쪽 패널을 그 Theater 로 연다.
   * 없으면 Theater 도구는 비활성으로 선다.
   */
  open(surfaceId: string, params?: Readonly<Record<string, unknown>>): boolean;
  /** 지금 선 대화를 걷는다. surfaceId 를 주면 그 대화일 때만 걷는다. */
  close(surfaceId?: string): void;
  /** 지금 가운데 칸에 선 플러그인 대화. 없으면 null — 같은 값이면 같은 참조를 돌려준다. */
  current(): { readonly surfaceId: string; readonly params: Readonly<Record<string, unknown>> } | null;
  /**
   * 지금 화면에 선 Objective 대화의 주인 id — 대화 중심 화면의 가운데 칸, 모바일이면 열린 Objective 화면. 없으면 null.
   * 대화 중심 화면이 꺼진 호스트(모바일)에서도 그 대화를 실제로 볼 때만 여는 연결이 읽는다. subscribe 가 바뀜을 깨운다.
   */
  subjectObjectiveId?(): string | null;
  /**
   * 그룹 대화 참여자의 원장(가운데 칸에 읽기 전용으로 세운 그 참여자의 기존 본문) — 지금 연 참여자 id(지휘관이면 루트 id), 대화를 보고
   * 있으면 null. `subscribeLedger` 가 바뀜을 깨운다.
   */
  ledgerObjectiveId?(rootObjectiveId: string): string | null;
  /** 원장을 연다 — 루트 id 면 지휘관, 구성원 id 면 그 구성원, null 이면 대화로 돌아간다. 호스트 「구성원」 탭의 줄 누름과 같다. */
  openLedger?(rootObjectiveId: string, objectiveId: string | null): void;
  subscribeLedger?(listener: () => void): () => void;
}

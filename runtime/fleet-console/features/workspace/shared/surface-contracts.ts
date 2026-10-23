import type { ClientTheaterInboxCapability, TheaterInboxAddress } from "./theater-inbox.js";
import type { MongleState } from "./avatars.js";
import type { ReactNode, RefObject } from "react";
import type { ConsoleLocale } from "@fleet-console/i18n";
import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";
import type { ConsoleTheaterSummary } from "./console-state.js";
import type { ConsoleTheme } from "../../settings/shared/theme.js";
/**
 * 호스트 크롬에 서는 작은 플러그인 항목(이름은 옛 Command Band 에서 이어진 SDK 계약이다). 대화 중심 화면에서 부관 항목은
 * 사이드바 맨 위 줄 가운데에, 그 밖의 옛 항목은 사이드바 바닥의 호환 칸에 선다(새 요약은 sidebarFooterEntries). 호스트는 등록 순서대로
 * 세울 뿐이고, 버튼 문법은 플러그인의 책임이다. 사이드바 자리는 가용 폭에 따라 40·32·28px 이며 그 크기를
 * `--command-band-entry-size` 로 알린다 — 버튼 크기를 `var(--command-band-entry-size, 24px)` 로 받으면 어느 자리에도 맞는다.
 * 여러 머리를 그리는 항목은 `--command-band-entry-gap`(기본 4px, 최저 -14px)을 이웃 머리 사이 간격으로 받는다.
 * 음수는 겹침이므로 gap 대신 음수 margin으로 적용하고, hover·focus 머리는 앞으로 세운다. 크기·간격은 선택적 CSS 계약이다.
 */
export interface CommandBandEntryDescriptor {
  readonly id: string;
  readonly render: () => ReactNode;
}


/** 사이드바 바닥 아바타 오른쪽의 플러그인 요약. 호스트는 순서와 가용 폭을 소유한다. 본문은 플러그인이 그리며,
 * `data-sidebar-footer-unit` 을 단 요소는 폭이 모자랄 때 호스트가 오른쪽부터 숨긴다(첫 칸은 남는다).
 * null 을 그리면 자리를 차지하지 않는다. */
export interface SidebarFooterEntryContext {
  /** 아바타를 포함한 바닥 줄의 왼쪽 안쪽 끝. 팝업 기하는 이 명시적 닻을 쓰고 버튼 포커스는 플러그인이 소유한다. */
  readonly popoverAnchorRef: RefObject<HTMLElement | null>;
}

export interface SidebarFooterEntryDescriptor {
  readonly id: string;
  readonly render: (context: SidebarFooterEntryContext) => ReactNode;
}


/** 컴포저 오른쪽 위의 부속 항목. 호스트가 명시적으로 켠 대화 표면에만 서며 플러그인끼리 의존하지 않는다. */
export interface ComposerTopEntryContext {
  /** 생략하면 데스크톱으로 다룬다. */
  readonly layout?: "mobile" | "desktop";
  /** 상세 팝업을 여는 요약 줄. 버튼 포커스는 항목이 소유한다. */
  readonly popoverAnchorRef: RefObject<HTMLElement | null>;
}

export interface ComposerTopEntryDescriptor {
  readonly id: string;
  readonly render: (context: ComposerTopEntryContext) => ReactNode;
}


/**
 * 상주 기여가 받는 콘솔 전역 사실. 패널이 하나도 열려 있지 않아도 참이어야 하는 것들이다 —
 * 로케일·테마는 열린 화면의 속성이 아니라 콘솔의 속성이므로, 화면을 통해서만 전해지면
 * 아무 화면도 없을 때 플러그인은 기본값에 갇힌다.
 */
export interface PersistentComponentContext {
  readonly language?: ConsoleLocale;
  readonly theme?: ConsoleTheme;
  /**
   * 지금 콘솔이 서 있는 배치. 보기를 바꾸면 값이 바뀌고 상주 기여는 다시 그려진다. 폰 배치(`"mobile"`)에서는 데스크톱 전용
   * 표면(포털 시트·서랍)을 그리지 않아야 한다. 구버전 호스트에는 없을 수 있다 — 없으면 `"desktop"`으로 다룬다.
   */
  readonly layout?: "mobile" | "desktop";
}


/** 화면 없는 상주 기여. 호스트가 콘솔 수명 동안 마운트해 둔다. */
export interface PersistentComponentDescriptor {
  readonly id: string;
  readonly render: (ctx: PersistentComponentContext) => ReactNode;
}


export interface ObjectiveCaptionContributionContext {
  readonly objectiveRecord: ObjectiveRecord;
  readonly language: "en" | "ko";
  /** 캔버스 캡션(넓은 칩)인지 사이드바 칩(12px 표식)인지. */
  readonly surface: "caption" | "chip";
}


export interface ObjectiveCaptionContribution {
  readonly id: string;
  readonly render: (context: ObjectiveCaptionContributionContext) => ReactNode;
}


/** 사이드바가 보여 주는 Theater와 화면 언어. 모든 등록 Theater는 동등하게 사용할 수 있다. */
export interface TheaterContributionContext {
  readonly theater: ConsoleTheaterSummary;
  /** @deprecated Mount는 없다. 등록된 모든 Theater에 대해 true이다. */
  readonly active: boolean;
  readonly language: "en" | "ko";
  /**
   * The host's Theater Inbox, scoped to the contributing plugin: `open` takes this plugin's own section id (the `id`
   * it declared in `theaterInboxSections`), and `read` reports this plugin's sections by that same id. Another owner's
   * section reads with its canonical id. Older hosts have none.
   */
  readonly theaterInbox?: ClientTheaterInboxCapability;
}


/** A Theater menu section also knows how to close the menu; close it before opening another surface. */
export interface TheaterMenuContext extends TheaterContributionContext {
  readonly onClose: () => void;
}


export interface TheaterContribution {
  readonly id: string;
  /**
   * A row the host shows directly under this Theater's sidebar header, above its Objective list, while the
   * section is expanded. It is a standing fact about the Theater, laid out on the sidebar row grammar; return
   * nothing to take no space. The host wraps each contribution in its own error boundary.
   */
  readonly row?: (context: TheaterContributionContext) => ReactNode;
  /**
   * The Theater's mark in its sidebar header, in place of the host's initials chip — for a plugin that operates the
   * Theater as a whole (its glyph says who runs it). Return null to keep the initials; the host asks again when
   * `header.subscribe` fires. The host gives the mark an 18px slot outside the header's activation button, so the
   * mark may hold its own button; a click that lands on no button inside the mark activates the header. The first
   * contribution that returns a mark wins.
   */
  readonly mark?: (context: TheaterContributionContext) => ReactNode;
  /** What the header reads from this contribution, besides its mark. */
  readonly header?: TheaterHeaderContribution;
  /**
   * Items in this Theater's actions menu (the header's context menu), after the host's system-prompt item and before
   * the host's own divider. Rows are `button.theater-menu-item` with a `menuitem*` role so the host's arrow-key
   * travel and Escape reach them; call `onClose` before opening another surface.
   */
  readonly menu?: (context: TheaterMenuContext) => ReactNode;
  /**
   * 폰의 Theater 동작 시트(Theater 시트의 행을 길게 누르면 서는, 그 Theater 의 동작)에 서는 행 — 시스템 프롬프트 다음, 「새 그룹…」 앞.
   * 활성이 아닌 Theater 에도 묻는다. 데스크톱은 이 필드를 읽지 않는다.
   * 데스크톱 `menu`는 DOM을 그리지만 폰 시트는 호스트의 행 문법으로 그리므로, 플러그인은 글과 동작만 준다.
   */
  readonly mobileRow?: TheaterContributionMobileRow;
}


/** A Theater commodore's face as a value — `off` is true while its operator is switched off, and the avatar is drawn muted. */
export interface TheaterFace {
  readonly state: MongleState;
  readonly off: boolean;
}


/** The Theater facts a contribution lends the sidebar header. Reads do no I/O. */
export interface TheaterHeaderContribution {
  /** Wakes the header when `mark`, `live`, `landing` or `face` may answer differently. */
  readonly subscribe: (listener: () => void) => () => void;
  /** True while this Theater's operator is working — the host runs its live sweep over the Theater name. */
  readonly live?: (theaterId: string) => boolean;
  /**
   * The face of the Theater's commodore avatar while this contribution operates it — the same state and the same
   * muted look its `mark` shows. The host draws the Theater's avatar with it on surfaces away from the sidebar header
   * (launcher chips, palette and picker rows), where a mark's own buttons cannot nest. Null leaves the face to the next
   * contribution, and finally to the host's resting face.
   */
  readonly face?: (theaterId: string) => TheaterFace | null;
  /**
   * The Theater Inbox page the header opens for this Theater, in this plugin's own section id. Null leaves the choice
   * to the next contribution, and finally to the host's system prompt page.
   */
  readonly landing?: (theaterId: string) => TheaterInboxAddress | null;
}


/** 폰 Theater 시트의 플러그인 행. `get`이 null이면 행이 없다(실험 기능이 꺼진 때). 호스트는 값(label)으로 비교한다. */
export interface TheaterContributionMobileRow {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: (theaterId: string, language: "en" | "ko") => { readonly label: string; /** 24 격자·선 1.7·`currentColor` 아이콘. */ readonly icon: ReactNode } | null;
  /** 행을 눌렀을 때 — 호스트가 시트를 모두 닫은 **뒤에** 부른다. */
  readonly run: (theaterId: string) => void;
}

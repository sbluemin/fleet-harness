import type { ReactNode } from "react";

import type { LocalizedText } from "../i18n/types.js";

/**
 * Settings 목록은 소유자가 아니라 하는 일로 묶인다. 소유자로 묶으면 "Console"과 "Terminal"
 * 아래에 같은 이름의 General이 둘 생기고, 겉모습 하나 바꾸려는 사람이 소유자를 먼저 알아야 한다.
 *
 * - `setup`   콘솔이 어떻게 보이고 어떤 말을 쓰는가. 자주 오고 되돌리기 쉽다.
 * - `work`    작업 도구가 어떻게 움직이는가. 플러그인 섹션의 기본 자리.
 * - `machine` 이 기계와 바깥의 관계. 드물고 결과가 무겁다.
 * - `experiments` 아직 다듬는 중인 기능. 전부 기본 꺼짐이고 켜는 것이 곧 동의다. 이 그룹의 플러그인
 *   섹션은 자기 칩을 갖지 않고 코어의 「실험 기능」 페이지 안에 카드로 선다.
 */
export type SettingsSectionGroup = "setup" | "work" | "machine" | "experiments";

export interface SettingsSectionDescriptor {
  readonly id: string;
  readonly title: LocalizedText;
  /** 생략하면 `work`. 플러그인 설정은 대부분 작업 도구의 동작이다. */
  readonly group?: SettingsSectionGroup;
  /**
   * 검색이 이 섹션을 찾는 데 쓰는 말. 섹션이 실제로 보여 주는 행 이름을 먼저 싣고, 그 이름에
   * 없는 개념어를 뒤에 더한다 — "dormant"를 찾는 사람은 그 설정이 AI Gateway 아래 있다는 것을
   * 모른다. 로케일을 받는 형태로 적어야 한국어 화면의 이름으로도 닿는다.
   */
  readonly keywords?: readonly LocalizedText[];
  readonly render?: () => ReactNode;
  /**
   * 폰(모바일 배치)의 설정 목록에서 이 섹션이 서는 방식. 데스크톱은 이 필드를 읽지 않는다 — 단 `only`면 데스크톱 목록에는 서지 않는다.
   */
  readonly mobile?: SettingsSectionMobile;
}

/** 폰 설정 목록의 묶음. `display` 화면 · `agent` 에이전트 · `use` 사용 · `about` 정보. */
export type MobileSettingsGroup = "display" | "agent" | "use" | "about";

export interface SettingsSectionMobile {
  /** 폰에서만 서는 섹션(데스크톱에는 이미 다른 자리가 있다). 생략하면 데스크톱과 같이 선다. */
  readonly only?: boolean;
  /** 생략하면 `group`(work → agent)에서 파생한다. */
  readonly group?: MobileSettingsGroup;
  /** 같은 묶음 안의 정렬 값. 작은 쪽이 위, 같으면 등록 순서. */
  readonly order?: number;
  /** 행의 보조 값 한 줄 — 열지 않고도 지금 값을 말한다. 값이 없으면 null. `subscribe`가 있으면 그 신호로 다시 읽는다. */
  /**
   * 모바일 「플러그인」 화면에 이 섹션을 행 하나로 올린다 — 제목은 섹션 `title`. 누르면 설정 › 이 섹션의 상세로 간다.
   * 레일 엔트리가 없는 플러그인(사용량 등)이 그 화면에 설 자리다. 사용할 수 있는 행이 먼저, 데스크톱 전용 행이 뒤에 선다.
   */
  readonly pluginRow?: {
    readonly icon?: import("react").ReactNode;
    readonly subtitle?: import("../i18n/types.js").LocalizedText;
  };
  readonly summary?: (locale: import("../i18n/types.js").ConsoleLocale) => string | null;
  readonly subscribe?: (listener: () => void) => () => void;
}

export type {
  ConsoleExperimentSettings,
  ComputerUseBackendId,
  ExperimentAideId,
  ExperimentAideSelection,
  ExperimentEffort,
  ExperimentModelOption,
} from "./experiments.js";
export {
  CLAUDE_EXPERIMENT_MODEL_OPTIONS,
  DEFAULT_EXPERIMENT_AIDE_SELECTION,
  DEFAULT_EXPERIMENT_SETTINGS,
  EXPERIMENT_AIDES,
  EXPERIMENT_EFFORTS,
  experimentAideSelection,
  isComputerUseBackendId,
  isExperimentEffort,
  isExperimentModelId,
  resolveExperimentSettings,
} from "./experiments.js";
export type { ShortcutBindings } from "./shortcuts.js";
export {
  SHORTCUT_CHORD_PATTERN,
  SHORTCUT_CHORDS_PER_COMMAND_MAX,
  isShortcutBindingsInput,
  isShortcutChord,
  sanitizeShortcutBindings,
} from "./shortcuts.js";

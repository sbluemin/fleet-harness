import type { ReactNode } from "react";

import type { LocalizedText } from "../i18n/types.js";

/**
 * Settings 목록은 소유자가 아니라 하는 일로 묶인다. 소유자로 묶으면 "Console"과 "Terminal"
 * 아래에 같은 이름의 General이 둘 생기고, 겉모습 하나 바꾸려는 사람이 소유자를 먼저 알아야 한다.
 *
 * - `setup`   콘솔이 어떻게 보이고 어떤 말을 쓰는가. 자주 오고 되돌리기 쉽다.
 * - `work`    작업 도구가 어떻게 움직이는가. 플러그인 섹션의 기본 자리.
 * - `machine` 이 기계와 바깥의 관계. 드물고 결과가 무겁다.
 */
export type SettingsSectionGroup = "setup" | "work" | "machine";

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
}

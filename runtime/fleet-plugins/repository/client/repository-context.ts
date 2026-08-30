import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ClientApiCapability } from "@fleet-console/sdk/plugin";

/**
 * 저장소 화면이 호스트에게서 실제로 받는 것.
 *
 * 이 패널은 레일 페인이 아니라 확대 표면에 선다. 두 계약의 컨텍스트는 모양이 다르지만 이
 * 화면이 읽는 것은 셋뿐이라, 그 셋만 요구하는 좁은 타입을 두어 어느 쪽에도 묶이지 않게 한다.
 */
export interface RepositoryContext {
  readonly theaterId: string | null;
  readonly api: ClientApiCapability;
  readonly language?: ConsoleLocale;
}

export const REPOSITORY_SURFACE_ID = "repository";

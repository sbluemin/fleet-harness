import type { CommodoreClientHost } from "../../commodore/shared/contracts/client.js";
import type { ConsoleCommodoreSummary } from "../../commodore/shared/contracts/theaters.js";
import type { ObjectiveClusterSource } from "../../objectives/shared/objective-clusters.js";
import type { ObjectiveRecord } from "../../objectives/shared/records/types.js";

/**
 * 코어가 `features/the-world`에 명시적으로 주입하는 의존성 객체.
 *
 * 타 피처의 내부 구현 경로를 직접 import하지 않고 공개 계약과 주입 포트만 소비한다.
 */
export interface WorldMessageResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
}

export interface TheWorldClientDeps {
  readonly commodore: CommodoreClientHost;
  readonly readCommodores: () => readonly ConsoleCommodoreSummary[];
  readonly subscribeCommodores: (listener: () => void) => () => void;
  readonly clusters: ObjectiveClusterSource;
  readonly readObjectiveRecords: () => readonly ObjectiveRecord[];
  readonly subscribeObjectiveRecords: (listener: () => void) => () => void;
  readonly getViewedCommodoreId: () => string | null;
  readonly getActiveObjectiveId: () => string | null;
  readonly isMobileLayout: () => boolean;
  readonly isReducedMotion: () => boolean;
  readonly isLowerUnfocusedFrameRate: () => boolean;
  readonly getAvatarFuzz: () => number;
  readonly openCommodoreInConsole: (
    commodoreId: string,
    options?: { readonly tab?: "log" | "info" | "memory" | "settings" | "goals" },
  ) => void;
  readonly openObjectiveInConsole: (commodoreId: string, objectiveId: string) => void;
  readonly sendMessageToCommodore: (commodoreId: string, text: string) => Promise<WorldMessageResult>;
  readonly sendMessageToObjective: (objectiveId: string, text: string) => Promise<WorldMessageResult>;
}

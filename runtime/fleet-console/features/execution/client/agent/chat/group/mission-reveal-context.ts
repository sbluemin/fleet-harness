import { createContext } from "react";

/** 선택적인 호스트 포트 — 원장의 전문 펼침과 스크롤은 기존 원장이 계속 소유한다. */
export interface MissionRevealPort {
  readonly objectiveId: string;
  readonly reveal: (missionId: string) => void;
  readonly label: string;
}

export const MissionRevealContext = createContext<MissionRevealPort | null>(null);

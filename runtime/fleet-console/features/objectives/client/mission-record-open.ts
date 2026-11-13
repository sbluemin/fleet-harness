import { useEffect, useRef, useState } from "react";

import { unseenRecords, type Objective, type ObjectiveMission } from "../shared/types.js";

/** 펼친 순간 이미 읽은 기록 — 「새 기록」 표시의 기준. 그 뒤 도착한 기록은 집합 밖에 남는다. */
const seenAtOpen = (mission: ObjectiveMission): ReadonlySet<string> =>
  new Set(mission.records.slice(0, Math.min(mission.seen, mission.records.length)).map((record) => record.id));

/**
 * 펼친 임무 기록. 목표 팝업과 우측 레일이 같은 규칙으로 쓴다.
 * 펼친 동안 안 읽은 기록이 있으면 `/mission/seen`을 알리고, 펼친 순간의 id 집합은 `MissionRecords`의 `seenAtOpen`이다.
 */
export function useOpenMissionRecords(
  objective: Objective,
  call: (path: string, body: Record<string, unknown>) => Promise<unknown>,
): {
  readonly openRecords: Readonly<Record<string, ReadonlySet<string>>>;
  readonly setOpenRecords: (update: (current: Readonly<Record<string, ReadonlySet<string>>>) => Readonly<Record<string, ReadonlySet<string>>>) => void;
  readonly toggleRecords: (mission: ObjectiveMission) => void;
} {
  const [openRecords, setOpenRecords] = useState<Readonly<Record<string, ReadonlySet<string>>>>({});
  useEffect(() => { setOpenRecords({}); }, [objective.id]);
  const seenPending = useRef(new Set<string>());
  useEffect(() => {
    for (const mission of objective.missions) {
      // 가장 최근 기록 id 로 거른다 — 기록 수는 상한에 닿으면 더 늘지 않아, 그 뒤의 새 기록을 알리지 못한다.
      const key = `${mission.id}:${mission.records.at(-1)?.id ?? ""}`;
      if (!(mission.id in openRecords) || unseenRecords(mission) === 0 || seenPending.current.has(key)) continue;
      seenPending.current.add(key);
      void call("/mission/seen", { objectiveId: objective.id, missionId: mission.id });
    }
  }, [objective, openRecords, call]);
  const toggleRecords = (mission: ObjectiveMission) => setOpenRecords((current) => {
    if (mission.id in current) {
      const { [mission.id]: _closed, ...rest } = current;
      return rest;
    }
    return { ...current, [mission.id]: seenAtOpen(mission) };
  });
  return { openRecords, setOpenRecords, toggleRecords };
}

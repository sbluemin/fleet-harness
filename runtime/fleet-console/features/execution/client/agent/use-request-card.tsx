import * as React from "react";
import { useObjectiveUseRequests, type ObjectiveUseRequest } from "../../../computer-use/client/computer-screen-share.js";
import { ApprovalComputerCard } from "../approval/cards.js";

/**
 * 허용 요청 — 이 Objective 의 AI 가 허용받지 않은 컴퓨터 사용 도구를 부르면 서버가 그 호출을
 * 붙잡아 두고, 사람이 답할 때까지 기다린다. 채팅·터미널 패널은 승인 카드로 허용 범위를 고른다.
 */

/** 남은 시간(초)을 1초마다 다시 센다. */
export function useUseRequestClock(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function UseRequestCards({ objectiveId, childSessionIds, placement }: { readonly objectiveId: string; readonly childSessionIds?: readonly string[]; readonly placement: "chat" | "terminal" }) {
  const requests = useObjectiveUseRequests(objectiveId, childSessionIds);
  const now = useUseRequestClock(requests.length > 0);
  if (requests.length === 0) return null;
  return (
    <div className={`use-request-stack is-${placement}`} data-keep-objective-active>
      {requests.map((request) => <UseRequestCard key={request.id} request={request} now={now} />)}
    </div>
  );
}

function UseRequestCard({ request, now }: { readonly request: ObjectiveUseRequest; readonly now: number }) {
  return <ApprovalComputerCard id={request.id} objectiveId={request.objectiveId} expiresAt={request.expiresAt} now={now} />;
}

import { React } from "@fleet-console/sdk/plugin/browser";

import { initialAgentChatLogState, readChatJournalEvent, reduceAgentChatLog, type AgentChatLogState } from "./chat-events.js";

export type AgentChatConnection = "connecting" | "open" | "lost" | "idle";

export interface AgentChatViewState extends AgentChatLogState {
  readonly connection: AgentChatConnection;
}

/**
 * Operation 하나의 chat-stream 구독.
 *
 * 서버는 접속(재접속 포함)마다 저널 전체를 되쓴다 — 저널의 첫 이벤트는 언제나 replay-start라
 * reducer가 스스로 초기화하지만, 저널이 상한으로 앞이 잘린 재접속에서도 상태가 겹으로 쌓이지
 * 않도록 open 시점에 로그 상태를 초기화한다. EventSource의 자동 재접속을 그대로 쓴다.
 *
 * `live`가 false면 소켓을 열지 않는다. 본문 풀이 주차·최소화·숨김 본문을 살려 두므로,
 * 그때도 구독하면 화면 밖 패널마다 HTTP/1.1 슬롯을 하나씩 점유한다. 덱 타일은 본문이
 * 그려지므로 live로 남긴다.
 */
export function useAgentChatStream(operationId: string, live = true): AgentChatViewState {
  const [connection, setConnection] = React.useState<AgentChatConnection>(live ? "connecting" : "idle");
  const [log, setLog] = React.useState<AgentChatLogState>(initialAgentChatLogState);

  React.useEffect(() => {
    if (!live) {
      setConnection("idle");
      return;
    }
    setConnection("connecting");
    setLog(initialAgentChatLogState);
    const source = new EventSource(`/plugins/terminal/agent/sessions/${encodeURIComponent(operationId)}/chat-stream`);
    source.onopen = () => {
      setConnection("open");
      setLog(initialAgentChatLogState);
    };
    source.onerror = () => {
      // EventSource가 스스로 재시도한다. CLOSED로 굳었을 때만 상실로 읽는다.
      setConnection(source.readyState === EventSource.CLOSED ? "lost" : "connecting");
    };
    source.onmessage = (message: MessageEvent<string>) => {
      const entry = readChatJournalEvent(message.data);
      if (!entry) return;
      setLog((current) => reduceAgentChatLog(current, entry.event));
    };
    return () => {
      source.close();
    };
  }, [operationId, live]);

  return React.useMemo(() => ({ ...log, connection }), [log, connection]);
}
